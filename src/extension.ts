import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCompatReport } from './compat';
import { decideUserPromptTurn, resetTurnText, samePromptTurn } from './cardLifecycle';
import {
  getAppSecret,
  readConfig,
  STATE_LAST_CHAT_ID,
  storeAppSecret,
  updateSetting,
} from './config';
import { applyCopilotPatch, copilotPatchStatus, patchScriptPath, restoreCopilotPatch } from './copilotPatch';
import { FeishuAdapter, InboundMessage } from './feishu/adapter';
import { buildStreamingCards, splitMarkdown } from './feishu/card';
import type { CardPair } from './feishu/card';
import { Injector } from './injector';
import { acquireOwnership } from './instance';
import { initLog, log, logError, setInstanceTag } from './log';
import { createTranscriptWatcher, createWatcher, resolveSessionPaths } from './session/store';
import { SessionWatcher } from './session/watcher';
import { TerminalWatch } from './session/terminalWatch';
import { TranscriptWatcher } from './session/transcript';

let watcher: SessionWatcher | undefined;
let transcript: TranscriptWatcher | undefined;
let feishu: FeishuAdapter | undefined;
let lastStartError = '';
let heartbeatCleanup: (() => void) | undefined;

const STATE_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  failed: '连接失败',
  idle: '空闲',
  stopped: '未启动',
};

/** 当前界面语言（中文环境为 zh-cn；扩展宿主测试桩里 env 可能不存在） */
const uiLanguage = (): string => (vscode.env && vscode.env.language) || 'en';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog();
  const label = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || vscode.workspace.name || 'window';
  const storageRoot =
    context.globalStorageUri?.fsPath || context.storageUri?.fsPath || (process.env.TEMP || '.') + '\\eww-bridge';
  // 锁按项目分桶：不同项目窗口各自推送自己的聊天，只有同一个文件夹的多个窗口才需要仲裁
  const ownership = acquireOwnership(storageRoot, label, label);
  setInstanceTag(ownership.owner ? `w:${ownership.instanceId}` : `p:${ownership.instanceId}`);
  context.subscriptions.push({ dispose: () => ownership.dispose() });
  if (!ownership.owner) {
    const passive = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    passive.text = '$(circle-slash) 飞书(同项目已接管)';
    passive.tooltip = `EWW Bridge：本窗口未启用。同一个项目（${ownership.scope}）已由 ${ownership.ownerLabel ?? '其它窗口'} 负责推送`;
    passive.show();
    context.subscriptions.push(passive);
    context.subscriptions.push(
      vscode.commands.registerCommand('ewwBridge.showStatus', () => {
        void vscode.window.showInformationMessage(
          `EWW Bridge：同一个项目已经由窗口「${ownership.ownerLabel ?? '其它'}」接管。不同项目请在不同文件夹打开窗口，或关闭重复窗口。`,
        );
      }),
    );
    for (const command of [
      'ewwBridge.setCredentials',
      'ewwBridge.connect',
      'ewwBridge.disconnect',
      'ewwBridge.testSend',
      'ewwBridge.setDefaultChat',
      'ewwBridge.showLogs',
      'ewwBridge.dumpCurrentSession',
      'ewwBridge.injectTest',
    ]) {
      context.subscriptions.push(
        vscode.commands.registerCommand(command, () => {
          void vscode.window.showWarningMessage(
            `EWW Bridge：本窗口未启用（项目 ${ownership.scope} 由 ${ownership.ownerLabel ?? '其它窗口'} 推送），请在接管窗口操作。`,
          );
        }),
      );
    }
    log(`EWW Bridge ${(context.extension as any)?.packageJSON?.version ?? '?'} 未启用（多实例仲裁）`);
    return;
  }
  log(`EWW Bridge activated v${(context.extension as any)?.packageJSON?.version ?? 'unknown'}`);

  watcher = createWatcher(context);
  watcher?.start();
  transcript = createTranscriptWatcher(context);
  transcript?.start();
  if (watcher) {
    watcher.partialIntervalMs = readConfig().streamingIntervalMs;
    // 有 transcript 实时源时，延长 chatSessions 的空闲兜底，避免长回合被提前判定结束
    watcher.idleFallbackMs = transcript ? 600000 : 120000;
  }
  if (transcript) {
    transcript.partialIntervalMs = readConfig().streamingIntervalMs;
  }

  // 后台终端：等待期间 transcript/chatSessions 完全不落盘，只能靠 shell 执行事件做状态提示
  const terminalWatch = new TerminalWatch();
  terminalWatch.start();
  context.subscriptions.push({ dispose: () => terminalWatch.dispose() });

  // 卡片出现真实内容/工具进展的时间，作为“注入已生效”的确认信号（占位心跳不算）
  let lastContentActivityAt = 0;
  const injector = new Injector(watcher, transcript, () => lastContentActivityAt, terminalWatch);
  let lastChatId: string = context.globalState.get<string>(STATE_LAST_CHAT_ID, '') || '';

  // ---- 推送目标：按工作区记忆，切换工程自动回落到该工程上次用的会话 ----
  const WORKSPACE_CHAT_KEY = 'ewwBridge.chatByWorkspace';
  const RECENT_CHATS_KEY = 'ewwBridge.recentChats';
  interface RecentChat {
    id: string;
    at: number;
    workspace?: string;
  }
  const workspaceKey = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const chatBindings = (): Record<string, string> => {
    const stored = context.globalState.get<Record<string, string>>(WORKSPACE_CHAT_KEY);
    return stored && typeof stored === 'object' ? stored : {};
  };
  const boundChatId = (): string => chatBindings()[workspaceKey()] || '';
  const recentChats = (): RecentChat[] => {
    const stored = context.globalState.get<RecentChat[]>(RECENT_CHATS_KEY);
    return Array.isArray(stored) ? stored : [];
  };
  const rememberChat = (chatId: string): void => {
    if (!chatId) {
      return;
    }
    lastChatId = chatId;
    void context.globalState.update(STATE_LAST_CHAT_ID, chatId);
    const next = [
      { id: chatId, at: Date.now(), workspace: workspaceKey() },
      ...recentChats().filter((item) => item.id !== chatId),
    ];
    void context.globalState.update(RECENT_CHATS_KEY, next.slice(0, 10));
  };
  const bindChatToWorkspace = (chatId: string): void => {
    const key = workspaceKey();
    if (!key) {
      void vscode.window.showWarningMessage('当前窗口没有打开文件夹，无法按工作区绑定。');
      return;
    }
    const next = { ...chatBindings() };
    if (chatId) {
      next[key] = chatId;
    } else {
      delete next[key];
    }
    void context.globalState.update(WORKSPACE_CHAT_KEY, next);
    rememberChat(chatId);
    updateStatus();
  };

  const echoQueue: { text: string; at: number }[] = [];
  const rate = new Map<string, number[]>();
  /** transcript 已即时镜像过的提问，避免 chatSessions 迟到后再发一次 */
  const seenUserPrompts = new Map<string, number>();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'ewwBridge.showStatus';
  status.show();
  context.subscriptions.push(status);

  const targetChatId = () => boundChatId() || readConfig().defaultChatId || lastChatId;

  const statusText = (): string => {
    const snapshot = watcher?.getStatus();
    const state = feishu?.connectionState() ?? 'stopped';
    return [
      `连接: ${STATE_LABEL[state] ?? state}`,
      `会话: ${snapshot?.sessionId || '-'}`,
      `镜像对话: ${transcript?.pinnedFile ? `已固定 ${transcript.currentSessionId.slice(0, 8)}` : '自动跟随最新'}`,
      `请求数: ${snapshot?.requests ?? 0}`,
      `忙碌: ${snapshot?.busy ? '是' : '否'}`,
      `注入队列: ${injector.pending}`,
      `推送目标: ${targetChatId() || '未设置'}${boundChatId() ? '（本工作区已绑定）' : ''}`,
      `注入方式: ${readConfig().newChat ? '每次新会话' : '追加当前会话'}`,
      `界面语言: ${uiLanguage()}${uiLanguage().startsWith('zh') ? '' : '（命令标题会显示英文）'}`,
      lastStartError ? `最近错误: ${lastStartError}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const updateStatus = (): void => {
    const state = feishu?.connectionState();
    if (state === 'connected') {
      status.text = '$(broadcast) 飞书';
    } else if (feishu?.started) {
      status.text = '$(sync~spin) 飞书';
    } else {
      status.text = '$(circle-slash) 飞书';
    }
    status.tooltip = statusText();
    status.backgroundColor = state === 'connected' ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  };

  const normalize = (text: string) => text.replace(/\s+/g, '');
  const rememberEcho = (text: string) => {
    echoQueue.push({ text: normalize(text), at: Date.now() });
    while (echoQueue.length > 20) {
      echoQueue.shift();
    }
  };
  const consumeEcho = (text: string): boolean => {
    const normalized = normalize(text);
    const index = echoQueue.findIndex((entry) => entry.text === normalized && Date.now() - entry.at < 300_000);
    if (index >= 0) {
      echoQueue.splice(index, 1);
      return true;
    }
    return false;
  };

  // ---------------- 出站：会话 -> 飞书（实时流式） ----------------
  interface TurnStream {
    sessionId: string;
    chatId: string;
    messageId?: string;
    creating?: Promise<string | undefined>;
    /** 正在创建的那张卡片的渲染内容（用于判断建卡期间是否已产生更新的帧） */
    creatingV2?: string;
    createFailures: number;
    patches: number;
    lastRendered: string;
    lastPatchAt: number;
    softFinalText?: string;
    /** 当前卡片对应的请求下标（知道后才能拒绝迟到结果） */
    requestIndex?: number;
    /** 本回合开始时间；0 表示未知（例如扩展在回合中途才启动） */
    turnStartedAt: number;
    /** 已推送过终稿的时间；保留卡片用于接住迟到的完整文本，不再新建卡 */
    doneAt?: number;
    /** 单飞渲染：最近一帧待推内容与在途任务 */
    pendingPatch?: CardPair;
    patching?: Promise<void>;
    /** 最近一次收到的正文/工具，供心跳卡片复用，避免长回合无内容可推 */
    lastAnswerText?: string;
    lastTools?: string[];
    /** 最近一次真正收到本会话事件的时间（心跳/建卡区间不算），用于判定陈旧状态 */
    lastEventAt?: number;
    /** 本轮的用户提问原文：transcript 与 chatSessions 会各看到一次，同文本必须复用同一张卡 */
    promptText?: string;
    /** 提问序号（transcript.turnIndex）：与当前不同即说明这条状态属于上一轮 */
    turnSeq?: number;
    /** 诊断：待发送正文长度 / 已发送正文长度 */
    pendingTextLen?: number;
    lastSentTextLen?: number;
    /** 卡片上已经渲染过的正文长度：重载恢复后不允许被更短残段覆盖 */
    answerFloorLen?: number;
    /** 正文持久化节流：上次写入时间 / 上次写入长度 */
    lastTextPersist?: number;
    persistedTextLen?: number;
  }
  const activeStreams = new Map<string, TurnStream>();
  const finalized = new Map<string, string>();
  /**
   * 出站卡片的状态键：agent 会话期间 chatSessions 属于另一个聊天（甚至是另一段会话 id），
   * 必须和 transcript 用同一个键，否则同一次提问会建出两张卡，另一张永远停在“进行中”。
   */
  const outboundSessionId = (): string =>
    transcript?.currentSessionId || watcher?.getStatus().sessionId || '';
  const STREAM_STATE_KEY = 'ewwBridge.streamCard';
  /** 卡片正文最多持久化这么多字符（与卡片 answerLimit 一致） */
  const PERSIST_TEXT_MAX = 12000;
  interface PersistedStream {
    sessionId: string;
    messageId: string;
    requestIndex?: number;
    answerLen?: number;
    answerText?: string;
  }
  const saveStreamState = (
    sessionId: string,
    messageId: string,
    requestIndex?: number,
    answerText?: string,
  ): void => {
    const text = answerText ? answerText.slice(0, PERSIST_TEXT_MAX) : undefined;
    void context.workspaceState.update(STREAM_STATE_KEY, {
      sessionId,
      messageId,
      requestIndex,
      // 与回退守卫保持同一口径（去空白后的长度）
      answerLen: text ? normalize(text).length : undefined,
      answerText: text,
      updatedAt: Date.now(),
    });
  };
  /** 同一回合内取更长的一份，避免旧快照/迟到的短文本把卡片改短 */
  const pickLonger = (a: string, b: string): string => ((a || '').length >= (b || '').length ? a : b);
  const clearStreamState = (): void => {
    void context.workspaceState.update(STREAM_STATE_KEY, undefined);
  };
  // 重载时恢复未完成的流式卡片，避免另开一张卡导致"内容被截断"
  let pendingReplayIndex: number | undefined;
  const restored = context.workspaceState.get<PersistedStream>(STREAM_STATE_KEY);
  if (restored && outboundSessionId() !== restored.sessionId) {
    log(
      `outbound: 跳过卡片恢复（会话不匹配 ${restored.sessionId.slice(0, 8)} vs ${outboundSessionId().slice(0, 8) || '-'}）`,
    );
  }
  if (restored && outboundSessionId() === restored.sessionId) {
    // agent 会话下 chatSessions 属于另一个聊天：既不能借它的 startedMidTurn，也不能重放它的结果
    const agentSession = !!transcript?.isAgentSession;
    if (agentSession || watcher?.startedMidTurn) {
      activeStreams.set(restored.sessionId, {
        chatId: targetChatId() || '',
        sessionId: restored.sessionId,
        messageId: restored.messageId,
        createFailures: 0,
        patches: 1,
        lastRendered: '',
        lastPatchAt: Date.now(),
        turnStartedAt: 0,
        requestIndex: restored.requestIndex,
        lastAnswerText: restored.answerText,
        pendingTextLen: restored.answerLen,
        answerFloorLen: restored.answerLen,
      });
      log(
        `outbound: 恢复上次的流式卡片 ${restored.messageId} (request #${restored.requestIndex ?? '?'}, 已渲染 ${restored.answerLen ?? 0}ch${agentSession ? '，agent 会话' : ''})`,
      );
    } else {
      // 回合可能刚好在重载前结束，但上次实例没来得及定稿：重放最后一条结果补全同一张卡
      const status = watcher?.getStatus();
      if (status && status.requests > 0) {
        const lastIndex = status.requests - 1;
        activeStreams.set(restored.sessionId, {
          chatId: targetChatId() || '',
          sessionId: restored.sessionId,
          messageId: restored.messageId,
          createFailures: 0,
          patches: 1,
          lastRendered: '',
          lastPatchAt: Date.now(),
          turnStartedAt: 0,
          requestIndex: lastIndex,
          lastAnswerText: restored.answerText,
          pendingTextLen: restored.answerLen,
          answerFloorLen: restored.answerLen,
        });
        pendingReplayIndex = lastIndex;
        log(`outbound: 回合已结束，稍后重放 #${lastIndex} 补全上次卡片`);
      } else {
        clearStreamState();
      }
    }
  }
  const lastTurnStartedAt = new Map<string, number>();
  let suppressDeltaUntil = 0;
  // 中途重载时 transcript 只能拿到后半段：直接从当前进度开始推流，不再整轮静默
  if (watcher?.startedMidTurn) {
    log('outbound: 启动时回合未结束，将从当前进度开始推流');
  }

  // 正文多源合并：只允许同一回合的 chatSessions 正文参与，避免新回合把上一轮的答复带出来
  const turnTailText = (sessionId?: string): string => {
    if (!watcher?.partialState || !readConfig().patchStreamText) {
      return '';
    }
    const tail = watcher.tailText();
    if (!tail?.text) {
      return '';
    }
    const startedAt = sessionId ? (lastTurnStartedAt.get(sessionId) ?? 0) : 0;
    // 补丁流里上一回合的正文 firstAt 早于本回合起点 → 丢弃，避免上一条又串进来
    if (startedAt > 0 && tail.firstAt < startedAt - 5000) {
      return '';
    }
    return tail.text;
  };

  /**
   * 补丁流正文能否接在卡片现有正文后面：
   * 卡片必须已经有 >=24 字（来自 transcript 的真实本轮内容），且候选正文以它开头。
   * 只有这样才能保证不会把别的段落塞进当前卡片（实测事故：“新任务出现上一轮首位正文”）。
   */
  const tailCompatible = (base: string, candidate: string): boolean => {
    const a = normalize(base);
    const b = normalize(candidate);
    if (a.length < 24 || !b) {
      return false;
    }
    return b.startsWith(a.slice(0, 24));
  };

  const mergedAnswer = (fallback: string, index?: number): string => {
    if (transcript?.isAgentSession) {
      // agent 会话的 chatSessions 文件属于另一个聊天，任何长度比较都会串段：只用 transcript 正文
      return fallback;
    }
    if (watcher?.partialState) {
      const sessionId = watcher.getStatus().sessionId;
      const state = activeStreams.get(sessionId);
      const base = state?.lastAnswerText || fallback || '';
      const tail = turnTailText(sessionId);
      if (tail && tailCompatible(base, tail) && tail.length > base.length) {
        return tail;
      }
      return fallback;
    }
    // 没有回合下标就不碰 chatSessions：latestAnswerText() 不带下标返回的是“最后一条请求”，
    // 新回合刚开始时那还是**上一轮**的答案（实测新卡整段带上一条回复）。
    if (typeof index !== 'number') {
      return fallback;
    }
    const sessionText = watcher?.latestAnswerText(index) ?? '';
    return sessionText.length > (fallback || '').length ? sessionText : fallback;
  };

  /**
   * 回退守卫：重载后 transcript 只能拿到后半段、chatSessions 也可能只落盘了一部分，
   * 任何比“卡片上已渲染的长度”短很多的帧一律丢弃（否则用户会看到正文变短/丢一段）。
   */
  const regressedAnswer = (state: TurnStream | undefined, answer: string, allowShrink = false): boolean => {
    if (!state || allowShrink) {
      return false;
    }
    const floor = state.answerFloorLen ?? 0;
    if (floor <= 0) {
      return false;
    }
    const len = normalize(answer).length;
    if (len + 40 < floor * 0.98) {
      log(`outbound: 跳过回退帧（${len}ch < 已渲染 ${floor}ch）`);
      return true;
    }
    return false;
  };

  const cardTools = (config: ReturnType<typeof readConfig>, tools: string[]): string[] =>
    config.forwardTools ? tools : config.forwardProgress ? tools.slice(-3) : [];

  /** 终稿底部：计时改写成“已完成 · Ns”（用户停止时用“已停止”） */
  const doneFooter = (elapsedMs?: number, extra?: string, label = '已完成'): string => {
    const secs = elapsedMs && elapsedMs > 0 ? Math.max(1, Math.round(elapsedMs / 1000)) : 0;
    return [label, extra || '', secs ? `${secs}s` : ''].filter(Boolean).join(' · ');
  };

  /**
   * 卡片外观只由“整轮是否还在跑”决定，与这一帧来自增量 / 软收尾 / 工具事件无关：
   * 每步工具调用的 turn_end 不是整轮结束，按事件类型决定标题会让卡片在“处理中/已完成”之间反复。
   */
  const runningLook = (): { running: boolean; title: string; footer: string } => {
    // agent 会话每一步都有 turn_end：刚结束时先别急着标“已完成”，否则整轮还在跑就闪成完成态
    const running = (transcript?.isTurnRunning() ?? false) || (transcript?.recentlyEnded ?? false);
    return {
      running,
      title: running ? 'Copilot · 处理中…' : 'Copilot',
      footer: running ? '' : doneFooter(transcript?.elapsedMs),
    };
  };

  // 飞书消息按发送时间排序：提问卡片必须真正发出后才能建 Copilot 卡片，否则 Copilot 会压在“你 · VS Code”上面
  let pendingUserCard: Promise<unknown> | undefined;
  const waitUserCard = (card: Promise<unknown> | undefined): Promise<unknown> | undefined => {
    if (!card) {
      return undefined;
    }
    const gate = card.catch(() => false);
    pendingUserCard = gate;
    void gate.then(() => {
      if (pendingUserCard === gate) {
        pendingUserCard = undefined;
      }
    });
    return gate;
  };

  /**
   * 同一聊天里为不同会话键留下的占位卡：那个键再也收不到正文，不处理就会一直显示“进行中”。
   * 建新卡或心跳发现键已切换时，把它收成终态。
   */
  const orphanSince = new Map<string, number>();

  /**
   * 把一个再无后续的会话键收成终态：有正文就定稿，没正文就把占位卡改成说明文案。
   * 建卡还在途中的也要等拿到 messageId 再收，否则会留一张永远“进行中”的卡。
   */
  const retireStreamCard = (key: string, state: TurnStream, note: string): void => {
    stopHeartbeat(key);
    orphanSince.delete(key);
    if (activeStreams.get(key) === state) {
      activeStreams.delete(key);
    }
    const answer = pickLonger(state.lastAnswerText ?? '', state.softFinalText ?? '');
    const finish = (id: string): void => {
      void feishu
        ?.patchCardPair(
          id,
          buildStreamingCards({
            title: 'Copilot',
            answer: answer || note,
            expanded: false,
            showThinking: false,
            answerLimit: 12000,
            footer: doneFooter(),
          }),
        )
        .catch((error) => logError('outbound retire card failed', error));
      log(
        `outbound: 收尾孤儿卡片 #${id.slice(-8)}（会话 ${key.slice(0, 8)}，${answer ? `${answer.length}ch` : note}）`,
      );
    };
    if (state.messageId) {
      finish(state.messageId);
      return;
    }
    if (state.creating) {
      void state.creating
        .then((id) => {
          if (id) {
            finish(id);
          }
        })
        .catch(() => undefined);
    }
  };

  const retireOrphanPlaceholders = (chatId: string, keepSessionId: string): void => {
    for (const [key, other] of activeStreams) {
      if (key === keepSessionId || other.chatId !== chatId || other.doneAt) {
        continue;
      }
      retireStreamCard(key, other, '本轮的输出已转到新的卡片继续（会话标识变化）。');
    }
  };

  const pushStreamCard = async (sessionId: string, chatId: string, cards: CardPair): Promise<TurnStream> => {
    if (pendingUserCard) {
      try {
        await pendingUserCard;
      } catch {
        /* 提问卡片发送失败不影响处理卡片 */
      }
    }
    let state = activeStreams.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        chatId,
        createFailures: 0,
        patches: 0,
        lastRendered: '',
        lastPatchAt: Date.now(),
        lastEventAt: Date.now(),
        turnStartedAt: 0,
        turnSeq: transcript?.turnIndex,
      };
      activeStreams.set(sessionId, state);
      log(`outbound: stream card for ${sessionId.slice(0, 8)}`);
      retireOrphanPlaceholders(chatId, sessionId);
    }
    if (!state.messageId && !state.creating && feishu?.started && state.createFailures < 3) {
      state.creatingV2 = cards.v2;
      state.creating = feishu.sendCardPair(chatId, cards);
    }
    if (state.creating) {
      const messageId = await state.creating;
      const createdV2 = state.creatingV2 ?? '';
      state.creating = undefined;
      state.creatingV2 = undefined;
      state.messageId = messageId;
      if (!messageId) {
        state.createFailures += 1;
        log(`outbound: 卡片创建失败（第 ${state.createFailures} 次）`);
      } else if (createdV2 !== cards.v2) {
        // 建卡期间又来了更新的帧（例如刚发出就停止）：创建时写的是旧内容，必须补一次 patch
        log('outbound: 建卡期间内容已变化，补一次 patch');
        await patchStreamCard(state, cards);
        startHeartbeat(sessionId);
      } else {
        state.lastRendered = cards.v2;
        state.patches = 1;
        state.lastPatchAt = Date.now();
        saveStreamState(sessionId, messageId, state.requestIndex);
        startHeartbeat(sessionId);
      }
    }
    return state;
  };

  const patchStreamCard = async (state: TurnStream, cards: CardPair): Promise<void> => {
    if (!state.messageId) {
      log('outbound: patch skipped (no messageId)');
      return;
    }
    if (state.lastRendered === cards.v2) {
      // 内容没变化，不推（长回合可以无限次更新，不再有次数上限）
      return;
    }
    const startedAt = Date.now();
    const ok = await feishu!.patchCardPair(state.messageId, cards);
    if (ok) {
      state.patches += 1;
      state.lastRendered = cards.v2;
      state.lastPatchAt = Date.now();
      if (state.pendingTextLen !== undefined) {
        // 注意：回退守卫与 floor 都用“去空白后的长度”，不能拿原始长度当基准
        const normLen = normalize(state.lastAnswerText ?? '').length;
        if (normLen > (state.answerFloorLen ?? 0)) {
          state.answerFloorLen = normLen;
        }
        const text = state.lastAnswerText ?? '';
        const grew = text.length - (state.persistedTextLen ?? 0) >= 1000;
        if (grew || Date.now() - (state.lastTextPersist ?? 0) > 5000) {
          state.lastTextPersist = Date.now();
          state.persistedTextLen = text.length;
          saveStreamState(state.sessionId, state.messageId, state.requestIndex, text);
        }
      }
      if (state.pendingTextLen !== undefined && Math.abs(state.pendingTextLen - (state.lastSentTextLen ?? -1)) >= 80) {
        state.lastSentTextLen = state.pendingTextLen;
        log(`outbound: 卡片正文 ${state.pendingTextLen}ch 已发送（patch=${state.patches}）`);
      }
      if (state.patches <= 3 || state.patches % 10 === 0) {
        log(`outbound: stream patch=${state.patches} (+${Date.now() - startedAt}ms, ${cards.v2.length}ch)`);
      }
    } else {
      log(`outbound: stream patch FAIL #${state.messageId.slice(-8)} (${cards.v2.length}ch)`);
    }
  };

  // 同一张卡只允许一个在途 patch：期间新帧只保留最新一帧，避免并发/乱序与堆积
  const PATCH_MIN_MS = 1200;
  const queueStreamCard = (state: TurnStream, cards: CardPair): Promise<void> => {
    state.pendingPatch = cards;
    if (state.patching) {
      return state.patching;
    }
    const wait = Math.max(0, PATCH_MIN_MS - (Date.now() - state.lastPatchAt));
    state.patching = (async () => {
      try {
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        while (state.pendingPatch) {
          const next = state.pendingPatch;
          state.pendingPatch = undefined;
          await patchStreamCard(state, next);
        }
      } finally {
        state.patching = undefined;
      }
    })();
    return state.patching;
  };

  // 模型首字可能要几十秒：每 5s 刷新一下“已等待 Ns”，避免卡片看起来卡死
  const heartbeats = new Map<string, NodeJS.Timeout>();
  const stopHeartbeat = (sessionId: string): void => {
    const timer = heartbeats.get(sessionId);
    if (timer) {
      clearInterval(timer);
      heartbeats.delete(sessionId);
    }
  };
  const startHeartbeat = (sessionId: string): void => {
    if (heartbeats.has(sessionId)) {
      return;
    }
    const since = Date.now();
    const timer = setInterval(() => {
      const state = activeStreams.get(sessionId);
      if (!state || state.doneAt) {
        stopHeartbeat(sessionId);
        return;
      }
      // 会话键已经切到别处（agent 会话/换会话/新开对话）：这张卡再也收不到正文，
      // 不处理就会一直显示“进行中…（已等待 Ns）”。确认 15s 仍在别处再收尾，
      // 避免两个数据源 mtime 抖动造成的误判。
      const currentKey = outboundSessionId();
      if (currentKey && currentKey !== sessionId) {
        const since0 = orphanSince.get(sessionId) ?? Date.now();
        orphanSince.set(sessionId, since0);
        if (Date.now() - since0 >= 15000) {
          log(`outbound: 会话键已切到 ${currentKey.slice(0, 8)}，收尾旧卡片（${sessionId.slice(0, 8)}）`);
          retireStreamCard(sessionId, state, '会话已切换，本卡片不再更新。');
          return;
        }
      } else {
        orphanSince.delete(sessionId);
      }
      const running = transcript?.activeTools() ?? [];
      const top = running[running.length - 1];
      // 一直没有任何正文、也没有在途工具与后台命令：占位卡不该无限“进行中”
      const stateIdleMs = Date.now() - (state.lastEventAt ?? state.turnStartedAt ?? state.lastPatchAt);
      const quietTooLong = (transcript?.quietMs ?? 0) > 240000;
      if (!top && !terminalWatch.hasRecent() && quietTooLong && stateIdleMs > 240000 && !(state.lastAnswerText ?? '').trim()) {
        retireStreamCard(sessionId, state, '本轮没有产出文字输出。');
        return;
      }
      // 已软结束且没有在执行的工具：保持终稿外观，不再刷心跳
      if (!top && state.softFinalText) {
        stopHeartbeat(sessionId);
        return;
      }
      // VS Code 偶尔不写 turn_end：事件停了且无在途工具时主动收尾，否则卡片会永远停在“处理中”
      // 但后台命令还在跑、或一句话正文都没有（还在思考）时不能收尾
      const settledAnswer = (state.lastAnswerText ?? '').trim();
      if (!top && !terminalWatch.hasRecent() && transcript?.cardSettled && state.messageId && settledAnswer.length > 0) {
        void finalizeSettledCard(state);
        return;
      }
      const secs = Math.max(1, Math.round((Date.now() - since) / 1000));
      const runningFor = top ? Math.max(1, Math.round((Date.now() - top.startedAt) / 1000)) : 0;
      const shell = terminalWatch.current();
      const shellFor = shell ? Math.max(1, Math.round((Date.now() - shell.startedAt) / 1000)) : 0;
      const status = shell
        ? `后台命令运行中：${shell.command}（已 ${shellFor}s）`
        : top
          ? `正在执行 ${top.name}${top.detail ? `：${top.detail}` : ''}（已 ${runningFor}s）`
          : `进行中…（已等待 ${secs}s）`;
      const heartbeatAnswer = state.lastAnswerText ?? '';
      if (regressedAnswer(state, heartbeatAnswer)) {
        // 已渲染正文比当前快照长（常见于重载后只拿到后半段）：不回退，等更长文本
        return;
      }
      const cards = buildStreamingCards({
        title: state.softFinalText ? 'Copilot' : 'Copilot · 处理中…',
        tools: state.lastTools ?? [],
        answer: heartbeatAnswer,
        status,
        expanded: false,
        showThinking: false,
      });
      void (async () => {
        try {
          if (state.messageId) {
            await queueStreamCard(state, cards);
          } else if (state.creating) {
            await state.creating;
          }
        } catch (error) {
          logError('heartbeat patch failed', error);
        }
      })();
    }, 5000);
    heartbeats.set(sessionId, timer);
  };
  heartbeatCleanup = () => {
    for (const timer of heartbeats.values()) {
      clearInterval(timer);
    }
    heartbeats.clear();
  };

  /** 收尾兜底：transcript 已静默且无在途工具，但始终没收到 turn_end（VS Code 漏写） */
  const finalizeSettledCard = async (state: TurnStream): Promise<void> => {
    const answer = pickLonger(state.lastAnswerText ?? '', state.softFinalText ?? '');
    const cards = buildStreamingCards({
      title: 'Copilot',
      tools: [],
      answer: answer || '（本轮没有文字输出）',
      expanded: false,
      showThinking: false,
      answerLimit: 12000,
      footer: doneFooter(transcript?.elapsedMs),
    });
    state.pendingTextLen = answer.length;
    state.softFinalText = answer;
    state.doneAt = Date.now();
    stopHeartbeat(state.sessionId);
    try {
      await queueStreamCard(state, cards);
      log(`outbound: 事件已停止，主动收尾卡片 #${state.messageId?.slice(-8) ?? '-'}（${answer.length}ch）`);
    } catch (error) {
      logError('outbound settled finalize failed', error);
    }
  };

  // 后台命令开始/结束：立刻在卡片上体现状态，避免长时间显示“处理中”
  terminalWatch.onChanged = (activity, exitCode) => {
    const sessionId = outboundSessionId();
    if (!sessionId) {
      return;
    }
    const state = activeStreams.get(sessionId);
    if (!state?.messageId || state.doneAt) {
      return;
    }
    if (state.softFinalText && !transcript?.isTurnRunning()) {
      // 回合已收尾：后台命令的迟到事件不能再把卡片刷回“处理中”
      return;
    }
    const cards = buildStreamingCards({
      title: 'Copilot · 处理中…',
      tools: state.lastTools ?? [],
      answer: state.lastAnswerText ?? '',
      status: activity
        ? `后台命令运行中：${activity.command}`
        : `后台命令已结束${typeof exitCode === 'number' ? `（exit ${exitCode}）` : ''}，等待 Copilot 继续…`,
      expanded: false,
      showThinking: false,
    });
    void queueStreamCard(state, cards).catch((error) => logError('outbound shell status failed', error));
  };

  // 实时增量：transcript（回合进行中也会写）
  if (transcript) {
    transcript.onInterrupt = (content) => {
      const sessionId = transcript!.currentSessionId;
      const state = activeStreams.get(sessionId);
      stopHeartbeat(sessionId);
      const system = content.startsWith('[Terminal ');
      log(`transcript: turn interrupted by ${system ? 'terminal notification' : 'new user message'} (${content.length}ch)`);
      if (system) {
        // transcript 已过滤，此处仅兜底：后台终端通知不是中断，保留卡片状态继续同步
        return;
      }
      if (!state?.messageId || Date.now() - state.lastPatchAt < 15000) {
        return;
      }
      void (async () => {
        try {
          const cards = buildStreamingCards({
            title: 'Copilot · 已中断',
            status: system
              ? '本轮被 VS Code 的后台终端通知打断（队列会继续）'
              : '本轮被新消息打断（队列会继续）',
            expanded: false,
          });
          await feishu?.patchCardPair(state.messageId!, cards);
        } catch (error) {
          logError('outbound interrupt patch failed', error);
        } finally {
          activeStreams.delete(sessionId);
          clearStreamState();
          transcript?.reset();
        }
      })();
    };

    transcript.onSoftFinal = (event) => {
      const config = readConfig();
      startHeartbeat(event.sessionId);
      lastContentActivityAt = Date.now();
      if (!config.forwardAssistant || !config.forwardStreaming) {
        return;
      }
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      const state = activeStreams.get(event.sessionId);
      const aborted = event.aborted === true;
      // 新回合但卡片状态还没换：先清掉上一轮快照，否则软结束会把旧答案定稿到新卡
      const currentPrompt = transcript?.currentPrompt ?? '';
      const seq = transcript?.turnIndex ?? 0;
      const seqChanged = !!state && state.turnSeq !== undefined && state.turnSeq !== seq;
      if (state && (seqChanged || !samePromptTurn(state, currentPrompt))) {
        log(`outbound: 检测到新一轮提问（#${seq}），清空上一轮正文快照（软结束）`);
        resetTurnText(state, currentPrompt);
      }
      if (state) {
        state.turnSeq = seq;
      }
      const softAnswer0 = mergedAnswer(event.text, state?.requestIndex);
      if (!softAnswer0.trim() && !aborted) {
        // 只有思考/工具、还没正文：保持“处理中”，不要把卡片收尾成“没有文字输出”
        return;
      }
      if (aborted && !state?.messageId && !state?.creating) {
        // 没有卡片可收尾（例如重载后回看到一条早就停止的旧回合）：不要为它新建卡
        log('outbound: 停止的回合没有对应卡片，跳过');
        return;
      }
      const softAnswer = aborted ? softAnswer0 : pickLonger(softAnswer0, state?.lastAnswerText ?? '');
      if (!aborted && regressedAnswer(state, softAnswer)) {
        return;
      }
      if (state) {
        if (state.doneAt && normalize(state.softFinalText ?? '') === normalize(softAnswer)) {
          return;
        }
        state.softFinalText = softAnswer;
        state.lastAnswerText = softAnswer;
        state.lastTools = [];
        state.pendingTextLen = softAnswer.length;
        if (aborted) {
          // 用户已经停止：卡片定稿，后续迟到的事件不能再把它改回“处理中”
          state.doneAt = Date.now();
          stopHeartbeat(event.sessionId);
        }
      }
      // 外观只看整轮是否还在跑：软收尾只是正文快照，不能把仍在进行的回合画成“已完成”
      const look = runningLook();
      const cards = buildStreamingCards({
        title: aborted ? 'Copilot · 已停止' : look.title,
        thinking: config.forwardThinking ? event.thinking : '',
        tools: aborted || !look.running ? [] : cardTools(config, event.tools),
        answer: softAnswer || (aborted ? '（本轮已停止，未产生文字输出）' : '（本轮没有文字输出）'),
        status: aborted || !look.running ? '' : '本步已输出，等待 Copilot 继续…',
        expanded: false,
        showThinking: config.forwardThinking,
        thinkingLimit: 6000,
        answerLimit: 12000,
        footer: aborted ? doneFooter(transcript?.elapsedMs, '', '已停止') : look.footer,
      });
      if (state?.lastRendered === cards.v2) {
        return;
      }
      void (async () => {
        try {
          if (state?.messageId) {
            await queueStreamCard(state, cards);
            const ok = state.lastRendered === cards.v2;
            log(`outbound: soft finalize ${ok ? 'ok' : 'FAIL'} #${state.messageId.slice(-8)} (${cards.v2.length}ch)`);
          } else {
            const created = await pushStreamCard(event.sessionId, chatId, cards);
            if (aborted) {
              created.doneAt = Date.now();
              stopHeartbeat(event.sessionId);
            }
            log('outbound: soft finalize created card');
          }
        } catch (error) {
          logError('outbound soft finalize failed', error);
        }
      })();
    };

    transcript.onUserPrompt = (event) => {
      // 新一轮开始：上一轮的卡片要么已软结束（保留终稿），要么立即收尾，避免被新回合覆盖
      const previous = activeStreams.get(event.sessionId);
      const decision = decideUserPromptTurn(previous, event.text, undefined);
      if (previous && decision === 'release') {
        retireStreamCard(event.sessionId, previous, '（已开始新一轮，本卡片停止更新。）');
      } else if (previous) {
        previous.promptText = event.text;
        previous.lastEventAt = Date.now();
        if (decision === 'reset') {
          // 占位卡延续，但新回合不能带上一轮的任何正文快照
          previous.lastAnswerText = undefined;
          previous.softFinalText = undefined;
          previous.answerFloorLen = 0;
          previous.pendingTextLen = 0;
          previous.lastSentTextLen = undefined;
          previous.persistedTextLen = 0;
        }
      }
      // transcript 只知“何时看到提问”，chatSessions 的 request.timestamp 才是回合起点：同一个回合内取较早值
      const now = Date.now();
      const knownStart = lastTurnStartedAt.get(event.sessionId) ?? 0;
      lastTurnStartedAt.set(
        event.sessionId,
        knownStart > 0 && now - knownStart < 600000 ? Math.min(knownStart, now) : now,
      );
      const config = readConfig();
      const promptChatId = targetChatId();
      const needCard =
        config.forwardAssistant &&
        config.forwardStreaming &&
        !!promptChatId &&
        !!feishu?.started &&
        !activeStreams.get(event.sessionId)?.messageId;
      // transcript 驱动模式下（chatSessions 残缺），占位卡必须在这里创建，否则新一轮没有卡片
      const createPlaceholderCard = (): void => {
        if (!needCard || !promptChatId) {
          return;
        }
        void pushStreamCard(
          event.sessionId,
          promptChatId,
          buildStreamingCards({
            title: 'Copilot · 处理中…',
            status: '已收到，正在处理…',
            expanded: false,
            showThinking: config.forwardThinking,
          }),
        ).then((created) => {
          if (!created.turnStartedAt) {
            created.turnStartedAt = now;
          }
          created.promptText = event.text;
          created.lastEventAt = now;
          if (created.messageId) {
            saveStreamState(event.sessionId, created.messageId, created.requestIndex, created.lastAnswerText);
          }
        });
      };

      // 提问卡片先发：飞书按发送时间排序，晚发就会出现“Copilot 卡片在‘你 · VS Code’上方”
      let userCard: Promise<unknown> | undefined;
      if (config.forwardUser) {
        if (event.text.startsWith('[Terminal ')) {
          log('outbound: skip terminal notification prompt');
        } else if (consumeEcho(event.text)) {
          // 注入回读：不镜像
        } else if (promptChatId && feishu?.started) {
          const normalized = normalize(event.text);
          const mirroredAt = seenUserPrompts.get(normalized);
          if (!(mirroredAt && Date.now() - mirroredAt < 120000)) {
            seenUserPrompts.set(normalized, Date.now());
            if (seenUserPrompts.size > 50) {
              const oldest = seenUserPrompts.keys().next().value;
              if (oldest) {
                seenUserPrompts.delete(oldest);
              }
            }
            log(`outbound: user prompt via transcript (${event.text.length}ch)`);
            userCard = feishu.sendMarkdown(promptChatId, '你 · VS Code', event.text, 'grey', true);
            waitUserCard(userCard);
          }
        }
      }
      if (userCard) {
        // 等提问卡片真正落到飞书之后再建 Copilot 卡片
        void userCard.then(createPlaceholderCard, createPlaceholderCard);
      } else {
        createPlaceholderCard();
      }
    };

    transcript.onDelta = (event) => {
      const config = readConfig();
      startHeartbeat(event.sessionId);
      lastContentActivityAt = Date.now();
      if (activeStreams.get(event.sessionId)?.doneAt) {
        // 已推过终稿：等 watcher 的完整结果，避免回退到更短的流式内容
        return;
      }
      if (!config.forwardAssistant || !config.forwardStreaming) {
        return;
      }
      if (Date.now() < suppressDeltaUntil) {
        return;
      }
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      void (async () => {
        try {
          const existing = activeStreams.get(event.sessionId);
          // 新回合但卡片状态还没换：先清掉上一轮快照，否则 pickLonger 会把旧答案留在新卡上
          const currentPrompt = transcript?.currentPrompt ?? '';
          const seq = transcript?.turnIndex ?? 0;
          const seqChanged = !!existing && existing.turnSeq !== undefined && existing.turnSeq !== seq;
          if (existing && (seqChanged || !samePromptTurn(existing, currentPrompt))) {
            log(`outbound: 检测到新一轮提问（#${seq}），清空上一轮正文快照（增量）`);
            resetTurnText(existing, currentPrompt);
          }
          if (existing) {
            existing.turnSeq = seq;
          }
          const answer = pickLonger(mergedAnswer(event.text, existing?.requestIndex), existing?.lastAnswerText ?? '');
          if (regressedAnswer(existing, answer)) {
            return;
          }
          const look = runningLook();
          const cards = buildStreamingCards({
            title: look.title,
            thinking: config.forwardThinking ? event.thinking : '',
            answer,
            tools: look.running ? cardTools(config, event.tools) : [],
            status: look.running ? '正在输出…' : '',
            expanded: false,
            showThinking: config.forwardThinking,
            footer: look.footer,
          });
          if (existing) {
            existing.lastAnswerText = answer;
            existing.lastTools = event.tools;
            existing.pendingTextLen = answer.length;
            existing.lastEventAt = Date.now();
          }
          if (existing?.messageId) {
            await queueStreamCard(existing, cards);
            return;
          }
          await pushStreamCard(event.sessionId, chatId, cards);
        } catch (error) {
          logError('outbound delta failed', error);
        }
      })();
    };

    // 工具开始/结束：长终端运行期间也要让卡片看到进展（否则用户以为卡住了）
    transcript.onTool = (activity) => {
      const sessionId = transcript!.currentSessionId;
      if (!sessionId) {
        return;
      }
      startHeartbeat(sessionId);
      const state = activeStreams.get(sessionId);
      if (!state?.messageId || state.doneAt) {
        return;
      }
      state.lastEventAt = Date.now();
      const toolAnswer = state.lastAnswerText ?? '';
      if (regressedAnswer(state, toolAnswer)) {
        // 已渲染的正文比当前快照长：不回退，只保留心跳
        return;
      }
      const look = runningLook();
      const cards = buildStreamingCards({
        title: look.title,
        tools: look.running ? (state.lastTools ?? []) : [],
        answer: toolAnswer,
        status: look.running
          ? activity
            ? `正在执行 ${activity.name}${activity.detail ? `：${activity.detail}` : ''}`
            : '工具执行完成，处理中…'
          : '',
        expanded: false,
        showThinking: false,
        footer: look.footer,
      });
      void (async () => {
        try {
          await queueStreamCard(state, cards);
        } catch (error) {
          logError('outbound tool progress failed', error);
        }
      })();
    };
  }

  if (watcher) {
    // 补丁流拿到新正文：即使 transcript 还没落盘（后台等待期），也立刻推进卡片
    watcher.onTailText = (event) => {
      if (!readConfig().patchStreamText || transcript?.isAgentSession) {
        // 默认关闭；agent 会话时 chatSessions 属于别的聊天，绝不能混用
        return;
      }
      const state = activeStreams.get(event.sessionId);
      if (!state?.messageId || state.doneAt) {
        return;
      }
      // transcript 正活跃时以它为准，避免两个源互相抢写造成闪烁
      if (transcript && Date.now() - transcript.lastActivity < 5000) {
        return;
      }
      const answer = pickLonger(event.text, state.lastAnswerText ?? '');
      if (!tailCompatible(state.lastAnswerText ?? '', answer)) {
        return;
      }
      if (regressedAnswer(state, answer)) {
        return;
      }
      if (normalize(answer) === normalize(state.lastAnswerText ?? '')) {
        return;
      }
      const cards = buildStreamingCards({
        title: 'Copilot · 处理中…',
        tools: state.lastTools ?? [],
        answer,
        status: terminalWatch.hasRecent() ? '后台命令运行中，正文已更新' : '正在输出…',
        expanded: false,
        showThinking: false,
        answerLimit: 12000,
      });
      state.lastAnswerText = answer;
      state.pendingTextLen = answer.length;
      void queueStreamCard(state, cards).catch((error) => logError('outbound tail text failed', error));
      log(`outbound: 补丁流正文 ${answer.length}ch（transcript 静默 ${Math.round((transcript?.quietMs ?? 0) / 1000)}s）`);
    };

    // 补丁流里出现 result = 回合真正结束（只用来收尾，绝不引入补丁流正文，避免串段）
    watcher.onTailComplete = (event) => {
      if (transcript?.isAgentSession) {
        return;
      }
      const state = activeStreams.get(event.sessionId);
      if (!state?.messageId || state.doneAt) {
        return;
      }
      const startedAt = lastTurnStartedAt.get(event.sessionId) ?? 0;
      if (startedAt > 0 && event.firstAt < startedAt - 5000) {
        log('outbound: 忽略旧回合的 result');
        return;
      }
      const answer = state.lastAnswerText ?? '';
      if (!answer.trim()) {
        return;
      }
      log(`outbound: 补丁流收到 result #${event.index}，立即收尾（${answer.length}ch）`);
      void finalizeSettledCard(state);
    };

    watcher.onUser = (event) => {
      if (watcher!.partialState || transcript?.isAgentSession) {
        // agent 会话的提问由 transcript.onUserPrompt 即时推送；这里的 chatSessions 属于另一个聊天
        return;
      }
      const config = readConfig();
      if (event.text.startsWith('[Terminal ')) {
        log('outbound: skip terminal notification user message');
        return;
      }
      const promptStart = lastTurnStartedAt.get(event.sessionId) ?? 0;
      const eventStart = event.timestamp || Date.now();
      const sameTurn = promptStart > 0 && Math.abs(eventStart - promptStart) < 600000;
      lastTurnStartedAt.set(event.sessionId, sameTurn ? Math.min(promptStart, eventStart) : eventStart);
      let stream = activeStreams.get(event.sessionId);
      // 卡片上已经有内容时，新提问必须换新卡，否则短回答会覆盖上一轮长回答。
      // 但同一个提问会被 transcript 与 chatSessions 各看到一次（注入文本尤其明显）：
      // 文本相同就说明是同一回合，绝不能换卡，否则同一问题会并排出现两张“处理中”。
      if (stream) {
        switch (decideUserPromptTurn(stream, event.text, event.index)) {
          case 'release':
            log(`outbound: 新一轮 #${event.index}，上一轮的卡片收尾（不再覆盖）`);
            retireStreamCard(event.sessionId, stream, '（已开始新一轮，本卡片停止更新。）');
            clearStreamState();
            stream = undefined;
            break;
          case 'reuse':
            log(`outbound: 同一提问（#${event.index}）已由 transcript 建卡，沿用原卡片`);
            stream.promptText = event.text;
            stream.lastEventAt = Date.now();
            if (stream.requestIndex !== event.index) {
              stream.requestIndex = event.index;
            }
            break;
          default:
            break;
        }
      }
      if (stream) {
        if (stream.requestIndex !== event.index) {
          // 新回合：清空旧正文与已渲染基线
          stream.lastAnswerText = undefined;
          stream.softFinalText = undefined;
          stream.answerFloorLen = 0;
          stream.pendingTextLen = 0;
          stream.lastSentTextLen = undefined;
          stream.persistedTextLen = 0;
        }
        stream.requestIndex = event.index;
        if (!stream.turnStartedAt) {
          stream.turnStartedAt = event.timestamp || Date.now();
        }
        if (stream.messageId) {
          saveStreamState(event.sessionId, stream.messageId, stream.requestIndex, stream.lastAnswerText);
        }
      }
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      const echoed = consumeEcho(event.text);
      const normalized = normalize(event.text);
      const mirroredAt = seenUserPrompts.get(normalized);
      if (mirroredAt && Date.now() - mirroredAt < 120000) {
        // transcript 已即时发过这张提问卡片
        seenUserPrompts.delete(normalized);
      } else if (!echoed && config.forwardUser) {
        log(`outbound: user request #${event.index} (${event.text.length}ch)`);
        // 提问卡片先发，后续 pushStreamCard 会等它落库再建 Copilot 卡片
        waitUserCard(feishu.sendMarkdown(chatId, '你 · VS Code', event.text, 'grey', true));
      }
      // 无论发没发都登记，保证 transcript 迟到时不会再发一张重复的提问卡
      seenUserPrompts.set(normalized, Date.now());
      if (config.forwardAssistant && config.forwardStreaming && !activeStreams.get(event.sessionId)?.messageId) {
        void pushStreamCard(
          event.sessionId,
          chatId,
          buildStreamingCards({
            title: 'Copilot · 处理中…',
            status: '已收到，正在处理…',
            expanded: false,
            showThinking: config.forwardThinking,
          }),
        ).then((created) => {
          // 占位卡从创建起就绑定回合下标，否则最终结果无法校验归属，迟到结果会写错卡
          if (created.requestIndex === undefined) {
            created.requestIndex = event.index;
          }
          if (!created.turnStartedAt) {
            created.turnStartedAt = eventStart;
          }
          created.promptText = event.text;
          created.lastEventAt = Date.now();
          if (created.messageId) {
            saveStreamState(event.sessionId, created.messageId, created.requestIndex);
          }
        });
      }
    };

    // 兜底：transcript 不可用（或尚未产生增量）时，用 chatSessions 的增量
    watcher.onPartial = (event) => {
      if (watcher!.partialState || transcript?.isAgentSession) {
        return;
      }
      const config = readConfig();
      if (!config.forwardAssistant || !config.forwardStreaming) {
        return;
      }
      const existing = activeStreams.get(event.sessionId);
      if (existing?.requestIndex !== undefined && existing.requestIndex !== event.index) {
        log(`outbound: 跳过上一回合的增量 #${event.index}（卡片属于 #${existing.requestIndex}）`);
        return;
      }
      lastContentActivityAt = Date.now();
      if (activeStreams.get(event.sessionId)?.doneAt) {
        return;
      }
      if (transcript && transcript.currentSessionId === event.sessionId && Date.now() - transcript.lastActivity < 60000) {
        return;
      }
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      void (async () => {
        try {
          const current = activeStreams.get(event.sessionId);
          const answer = pickLonger(mergedAnswer(event.text, event.index), current?.lastAnswerText ?? '');
          if (regressedAnswer(current, answer)) {
            return;
          }
          const cards = buildStreamingCards({
            title: 'Copilot · 处理中…',
            thinking: config.forwardThinking ? event.thinking : '',
            answer,
            tools: cardTools(config, event.tools),
            status: '正在输出…',
            expanded: false,
            showThinking: config.forwardThinking,
          });
          const state = await pushStreamCard(event.sessionId, chatId, cards);
          state.requestIndex = event.index;
          state.lastAnswerText = answer;
          state.lastTools = event.tools;
          state.pendingTextLen = answer.length;
          state.lastEventAt = Date.now();
          await queueStreamCard(state, cards);
        } catch (error) {
          logError('outbound partial failed', error);
        }
      })();
    };

    watcher.onAssistant = (event) => {
      if (watcher!.partialState || transcript?.isAgentSession) {
        // 残缺尾部：终稿会由 transcript 的软结束推送，这里的下标/正文都不可信；
        // agent 会话的 chatSessions 文件属于另一个聊天，更不能拿来写当前卡片
        return;
      }
      const config = readConfig();
      if (!config.forwardAssistant) {
        return;
      }
      lastContentActivityAt = Date.now();
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      const aborted = event.aborted === true;
      const modelShort = (event.modelId || '').split('/').pop() || '';
      const footer = doneFooter(event.elapsedMs, modelShort);
      const state = activeStreams.get(event.sessionId);
      // chatSessions 的终稿可能没有正文（正文只在 transcript / 软结束里），此时必须沿用已有的
      const carried = (state?.softFinalText ?? '').length >= (state?.lastAnswerText ?? '').length
        ? state?.softFinalText ?? ''
        : state?.lastAnswerText ?? '';
      const effectiveText = event.text.trim() ? event.text : carried;
      const waitingMore =
        !effectiveText.trim() && !aborted && (event.thinking.trim().length > 0 || event.tools.length > 0);
      const answerText = waitingMore
        ? ''
        : effectiveText || (aborted ? '（本轮在 VS Code 侧被中断，未产生文字输出）' : '（本轮没有文字输出）');
      if (!waitingMore && regressedAnswer(state, answerText, aborted)) {
        // 终稿比卡片上已有的正文短：保留已有正文（重载后最容易出现）
        if (state) {
          state.doneAt = Date.now();
        }
        return;
      }
      const chunks = splitMarkdown(answerText);
      const firstChunk = chunks.shift() ?? '';
      const cards = buildStreamingCards({
        title: aborted ? 'Copilot · 已中断' : 'Copilot',
        thinking: config.forwardThinking ? event.thinking : '',
        tools: waitingMore ? cardTools(config, event.tools) : [],
        answer: firstChunk,
        status: waitingMore
          ? '仍在处理…'
          : aborted
            ? '本轮在 VS Code 侧被中断（常见原因：后台终端通知、手动停止或上下文超限）'
            : '',
        expanded: false,
        showThinking: config.forwardThinking,
        thinkingLimit: 6000,
        answerLimit: 12000,
        footer: waitingMore ? '' : footer,
      });
      const key = `${event.sessionId}#${event.index}`;
      const startedAt = state?.turnStartedAt || lastTurnStartedAt.get(event.sessionId) || 0;
      const staleByIndex = state?.requestIndex !== undefined && state.requestIndex !== event.index;
      // 时间判定只作兜底：两个数据源对“回合起点”的观测可能差几秒，阈值必须放宽
      const staleByTime =
        startedAt > 0 && typeof event.timestamp === 'number' && event.timestamp > 0
          ? event.timestamp + 120000 < startedAt
          : false;
      if (state && staleByIndex) {
        log(
          `outbound: 丢弃迟到结果 #${event.index}（卡片属于 #${state.requestIndex}，` +
            `事件时间 ${event.timestamp ?? '-'}，回合起点 ${startedAt || '-'}）`,
        );
        return;
      }
      if (state && staleByTime) {
        // 卡片还没绑定回合时宁可接受最新结果，也不要让它永远停在“处理中”
        if (state.requestIndex === undefined) {
          log(`outbound: 卡片未绑定回合，接受 #${event.index}（时间判定仅供参考，起点 ${startedAt}）`);
        } else {
          log(
            `outbound: 丢弃迟到结果 #${event.index}（卡片属于 #${state.requestIndex}，` +
              `事件时间 ${event.timestamp ?? '-'}，回合起点 ${startedAt || '-'}）`,
          );
          return;
        }
      }
      if (!state && staleByTime) {
        log(`outbound: 丢弃无主迟到结果 #${event.index}`);
        return;
      }
      if (state && !waitingMore) {
        state.pendingTextLen = answerText.length;
      }
      if (state && state.requestIndex === undefined) {
        state.requestIndex = event.index;
      }
      if (state) {
        state.lastAnswerText = event.text;
        state.lastTools = event.tools;
        state.lastEventAt = Date.now();
      }
      // 防止软结束（transcript 完整）被更短的最终文本覆盖导致“截断”
      if (state?.softFinalText && !aborted && !waitingMore) {
        const softLen = normalize(state.softFinalText).length;
        const finalLen = normalize(event.text).length;
        if (softLen > 0 && finalLen < softLen * 0.9) {
          log(`outbound: 最终文本较短（${finalLen} < ${softLen}），保留软结束内容 #${event.index}`);
          state.doneAt = Date.now();
          return;
        }
      }
      const signature = `${event.text.length}|${event.thinking.length}|${event.tools.length}`;
      if (finalized.get(key) === signature) {
        return;
      }
      finalized.set(key, signature);
      if (finalized.size > 200) {
        const oldest = finalized.keys().next().value;
        if (oldest) {
          finalized.delete(oldest);
        }
      }
      log(`outbound: assistant #${event.index} complete=${event.complete} aborted=${aborted} (${event.text.length}ch, tools=${event.tools.length})`);

      void (async () => {
        let sent = false;
        try {
          if (!waitingMore && state) {
            // 先阻塞后续增量帧，再把在途的流式卡更新冲刷完，保证终稿最后落卡
            state.doneAt = Date.now();
            state.pendingPatch = undefined;
            await state.patching;
          }
          let messageId = state?.messageId;
          if (!messageId && state?.creating) {
            messageId = await state.creating;
          }
          if (messageId) {
            let ok = await feishu!.patchCardPair(messageId, cards);
            if (!ok) {
              // 飞书偶发失败（限频/内容超限）：短暂重试，避免直接另建一张重复卡片
              await new Promise((resolve) => setTimeout(resolve, 700));
              ok = await feishu!.patchCardPair(messageId, cards);
            }
            log(`outbound: final patch ${ok ? 'ok' : 'FAIL'} #${messageId.slice(-8)} (${cards.v2.length}ch)`);
            if (ok) {
              sent = true;
              if (state) {
                state.lastRendered = cards.v2;
                state.patches += 1;
              }
            }
          }
          if (!sent && messageId) {
            log(`outbound: 卡片 #${messageId.slice(-6)} 更新失败，改为发送新卡片`);
            if (state) {
              state.messageId = undefined;
              state.lastRendered = '';
            }
          }
          if (!sent) {
            const st = await pushStreamCard(event.sessionId, chatId, cards);
            if (st.messageId) {
              st.lastRendered = cards.v2;
              st.patches = 1;
            }
          }
          for (const chunk of chunks) {
            await feishu!.sendMarkdown(chatId, 'Copilot', chunk, 'blue');
          }
        } catch (error) {
          logError('outbound final failed', error);
        } finally {
          if (waitingMore) {
            // 不是终稿：保留状态与 transcript 累计，等完整文本到来后更新同一张卡
            return;
          }
          stopHeartbeat(event.sessionId);
          // 终稿也要保留状态：chatSessions 后续可能再推一条更完整的文本，必须回写到同一张卡
          if (state) {
            state.doneAt = Date.now();
            state.softFinalText = event.text;
            state.patches += 1;
          }
          suppressDeltaUntil = Date.now() + 3000;
          clearStreamState();
          transcript?.reset();
        }
      })();
    };
  }

  // 出站处理器已就绪：补全重载前未定稿的卡片
  if (pendingReplayIndex !== undefined) {
    if (transcript?.isAgentSession) {
      // agent 会话期间 chatSessions 属于另一个聊天，重放会把别人的正文写进这张卡
      log('outbound: agent 会话，跳过 chatSessions 历史重放');
    } else if (watcher?.partialState) {
      // 残缺尾部里的“最后一条”很可能是几小时前的旧请求，重放会往卡片里塞无关内容
      log('outbound: chatSessions 为残缺尾部，跳过历史重放');
    } else {
      watcher?.replayLast(pendingReplayIndex);
    }
    pendingReplayIndex = undefined;
  }

  // ---------------- 入站：飞书 -> 当前会话 ----------------
  const handleInbound = async (message: InboundMessage): Promise<void> => {
    const reply = (text: string) => feishu?.sendText(message.chatId, text);
    if (message.chatId) {
      rememberChat(message.chatId);
      // 首次在某工作区收到消息：自动把这个会话绑到该工作区，省掉手动配置
      if (!boundChatId()) {
        const key = workspaceKey();
        if (key) {
          const next = { ...chatBindings(), [key]: message.chatId };
          void context.globalState.update(WORKSPACE_CHAT_KEY, next);
          log(`inbound: 自动把 ${message.chatId} 绑定到工作区 ${key}`);
        }
      }
      updateStatus();
    }

    let config = readConfig();
    const PAIRED_KEY = 'ewwBridge.pairedOpenIds';
    const paired = (): string[] => {
      const stored = context.globalState.get<string[]>(PAIRED_KEY);
      return Array.isArray(stored) ? stored : [];
    };
    const allowed = new Set([...config.allowedOpenIds, ...paired()]);
    if (allowed.size === 0) {
      // 白名单为空 = 首次配对：自动信任来信者（存 globalState，不污染设置文件）
      const next = Array.from(new Set([...paired(), message.openId]));
      void context.globalState.update(PAIRED_KEY, next);
      log(`inbound: 白名单为空，自动信任首个发送者 open_id=${message.openId}`);
      await reply(
        '已自动信任你的账号，并记住这个会话。\n之后直接发消息即可下发任务；需要限制他人时在设置 ewwBridge.security.allowedOpenIds 里维护。',
      );
      config = readConfig();
    } else if (!allowed.has(message.openId)) {
      await reply(`未授权。\n你的 open_id：${message.openId}`);
      log(`inbound rejected (not allowed) open_id=${message.openId}`);
      return;
    }

    let text = message.text.trim();
    if (!text) {
      await reply('目前只支持文本消息。');
      return;
    }
    if (config.prefix) {
      const prefixes = config.prefix
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const hit = prefixes.find((prefix) => text.startsWith(prefix));
      if (!hit) {
        await reply(`请以 ${prefixes.join(' 或 ')} 开头下发任务。`);
        return;
      }
      text = text.slice(hit.length).trim();
      if (!text) {
        await reply('口令后没有内容。');
        return;
      }
    }

    const now = Date.now();
    const stamps = (rate.get(message.openId) || []).filter((stamp) => now - stamp < 60_000);
    if (stamps.length >= 10) {
      await reply('触发频率限制（10 条/分钟），请稍后再试。');
      return;
    }
    stamps.push(now);
    rate.set(message.openId, stamps);

    if (text === '/help') {
      await reply('指令：\n/status 查看状态\n/stop 停止当前回答\n/clear 清空排队任务\n/new 新开会话\n其他文本 = 下发任务');
      return;
    }
    if (text === '/status') {
      await reply(statusText());
      return;
    }
    if (text === '/clear') {
      const cleared = injector.clearQueue();
      await reply(`已清空 ${cleared} 条排队任务。`);
      return;
    }
    if (text === '/stop') {
      await vscode.commands.executeCommand('workbench.action.chat.cancel');
      await reply('已请求停止当前回答。');
      return;
    }
    if (text === '/new') {
      await vscode.commands.executeCommand('workbench.action.chat.newChat');
      await reply('已在 VS Code 新开会话。');
      return;
    }

    if (!watcher) {
      await reply('当前窗口没有可用的 Copilot 会话目录，无法注入。');
      return;
    }

    rememberEcho(text);
    const position = injector.enqueue({
      text,
      timeoutMs: config.injectTimeoutMs,
      onInjected: () => {
        const busyNow = (watcher?.isBusy() ?? false) || (transcript ? Date.now() - transcript.lastActivity < 8000 : false);
        void reply(busyNow ? '已排队：当前回合还在运行，结束后会自动执行本条。' : '已提交到 VS Code 当前会话。');
        if (config.forwardAssistant && config.forwardStreaming && feishu?.started) {
          const streamChatId = targetChatId();
          // 必须和 transcript 的会话键一致：用 chatSessions 的 id 会在 agent 会话下另建一张永不更新的卡
          const sessionId = outboundSessionId();
          if (streamChatId && sessionId) {
            const previous = activeStreams.get(sessionId);
            // 新任务进来时上一轮必须收尾（保留它自己的内容），否则新卡会继承旧正文
            const previousHasContent = !!(previous?.lastAnswerText || previous?.softFinalText);
            if (previous && (!samePromptTurn(previous, text) || previous.doneAt || previousHasContent)) {
              retireStreamCard(sessionId, previous, '（已开始新一轮，本卡片停止更新。）');
              clearStreamState();
            }
            void pushStreamCard(
              sessionId,
              streamChatId,
              buildStreamingCards({
                title: 'Copilot · 处理中…',
                status: '已收到，正在处理…',
                expanded: false,
                showThinking: config.forwardThinking,
              }),
            ).then((created) => {
              // 记下本次提问：transcript / chatSessions 稍后看到同一条文本时必须复用这张卡
              created.promptText = text;
              created.lastEventAt = Date.now();
            });
          }
        }
      },
      onDeliveryFailed: () => {
        void reply('未能确认投递：VS Code 可能在后端/面板未就绪，消息可能已经进去但处理较慢。若一直无回复，请把 VS Code 窗口切到前台后重发。');
      },
      onAborted: () => {
        void reply('上一轮已结束但没有最终文本，已继续处理队列。');
      },
      onTimeout: () => {
        void reply('任务超时未结束，请回 VS Code 查看，或发送 /stop 终止。');
      },
    });
    if (position > 1) {
      await reply(`已排队（第 ${position} 位），当前任务结束后自动下发。`);
    }
    log(`inbound accepted open_id=${message.openId} queue=${position}`);
  };

  const startFeishu = async (): Promise<void> => {
    feishu?.stop();
    feishu = undefined;
    const config = readConfig();
    if (!config.enabled) {
      log('feishu: disabled by settings');
      updateStatus();
      return;
    }
    if (!config.appId) {
      log('feishu: 未配置 App ID');
      updateStatus();
      return;
    }
    const secret = await getAppSecret(context);
    if (!secret) {
      log('feishu: 未配置 App Secret');
      updateStatus();
      return;
    }
    try {
      lastStartError = '';
      feishu = new FeishuAdapter(config.appId, secret, (inbound) => void handleInbound(inbound));
      feishu.start();
      log('feishu: adapter started');
    } catch (error) {
      lastStartError = error instanceof Error ? error.message : String(error);
      logError('feishu start failed', error);
      feishu = undefined;
    }
    updateStatus();
  };

  // ---------------- 命令 ----------------
  const runCredentialSetup = async (): Promise<boolean> => {
    const current = readConfig();
    const appId = await vscode.window.showInputBox({
      title: '飞书自建应用 · App ID',
      value: current.appId,
      ignoreFocusOut: true,
      placeHolder: 'cli_xxxxxxxxxxxxxxxx',
    });
    if (!appId) {
      return false;
    }
    const appSecret = await vscode.window.showInputBox({
      title: '飞书自建应用 · App Secret',
      password: true,
      ignoreFocusOut: true,
      placeHolder: '输入后存入 VS Code 密钥库',
    });
    if (!appSecret) {
      return false;
    }
    await storeAppSecret(context, appSecret);
    await updateSetting('feishu.appId', appId.trim());
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ewwBridge.showLogs', () => initLog().show()),
    // 唯一入口：状态 + 常用操作（其余细碎命令都收进这里，命令面板只留少数几条）
    vscode.commands.registerCommand('ewwBridge.showStatus', async () => {
      type Action = vscode.QuickPickItem & { run: () => unknown };
      const state = feishu?.connectionState() ?? 'stopped';
      const items: Action[] = [];
      if (!readConfig().appId) {
        items.push({
          label: '$(gear) 快速设置…',
          description: '填写 App ID / Secret 并连接飞书',
          run: () => vscode.commands.executeCommand('ewwBridge.setup'),
        });
      }
      items.push({
        label: `$(broadcast) 连接：${STATE_LABEL[state] ?? state}`,
        description: '选中查看日志',
        run: () => initLog().show(),
      });
      items.push({
        label: `$(comment) 推送会话：${targetChatId() || '未设置'}`,
        description: boundChatId() ? '本工作区已绑定' : '全局默认',
        run: () => vscode.commands.executeCommand('ewwBridge.pickChat'),
      });
      items.push({
        label: `$(comment-discussion) 镜像对话：${
          transcript?.pinnedFile ? `已固定 ${transcript.currentSessionId.slice(0, 8)}` : '自动跟随最新'
        }`,
        run: () => vscode.commands.executeCommand('ewwBridge.pickSession'),
      });
      if (feishu?.started) {
        items.push({
          label: '$(debug-disconnect) 断开飞书',
          run: () => {
            feishu?.stop();
            feishu = undefined;
            updateStatus();
          },
        });
      } else {
        items.push({
          label: '$(plug) 连接飞书',
          run: async () => {
            await startFeishu();
          },
        });
      }
      items.push({
        label: '$(mail) 发送测试消息',
        run: () => vscode.commands.executeCommand('ewwBridge.testSend'),
      });
      if (copilotPatchStatus().state === 'clean') {
        items.push({
          label: '$(zap) 给内置 Copilot 打即时落盘补丁',
          description: '推荐：长任务时卡片才能实时更新',
          run: () => vscode.commands.executeCommand('ewwBridge.patchCopilotFlush'),
        });
      }
      items.push({
        label: '$(beaker) 兼容性自检',
        run: () => vscode.commands.executeCommand('ewwBridge.compatCheck'),
      });
      const pairedIds = context.globalState.get<string[]>('ewwBridge.pairedOpenIds') || [];
      if (pairedIds.length > 0) {
        items.push({
          label: `$(shield) 清除自动配对的白名单（${pairedIds.length} 人）`,
          description: '清空后下一次发消息的用户会被重新信任',
          run: async () => {
            await context.globalState.update('ewwBridge.pairedOpenIds', undefined);
            await vscode.window.showInformationMessage('已清除自动配对白名单。');
          },
        });
      }
      if (!uiLanguage().startsWith('zh')) {
        items.push({
          label: `$(globe) 切换界面语言为中文（当前 ${uiLanguage()}）`,
          description: '写入 argv.json，需要完全退出并重新打开 VS Code',
          run: async () => {
            const userData = context.globalStorageUri?.fsPath
              ? path.resolve(context.globalStorageUri.fsPath, '..', '..', '..')
              : '';
            if (!userData) {
              await vscode.window.showWarningMessage('无法定位 VS Code 用户数据目录。');
              return;
            }
            const file = path.join(userData, 'argv.json');
            let raw = '';
            try {
              raw = fs.readFileSync(file, 'utf8');
            } catch {
              raw = '// VS Code 启动参数\n{\n}\n';
            }
            if (/"locale"\s*:/.test(raw)) {
              raw = raw.replace(/"locale"\s*:\s*"[^"]*"/, '"locale": "zh-cn"');
            } else {
              raw = raw.replace(/\{\s*/, '{\n\t"locale": "zh-cn",\n');
            }
            try {
              fs.writeFileSync(file, raw, 'utf8');
            } catch (error) {
              await vscode.window.showErrorMessage(`写入 ${file} 失败：${String(error)}`);
              return;
            }
            await vscode.window.showInformationMessage(
              `已把界面语言设为中文（${file}）。\n请完全退出 VS Code 再重新打开（仅重载窗口不够）。`,
            );
          },
        });
      }
      items.push({ label: '$(output) 打开日志', run: () => initLog().show() });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'EWW Bridge',
        placeHolder: statusText().replace(/\n/g, ' · '),
        matchOnDescription: true,
      });
      if (picked?.run) {
        await picked.run();
      }
    }),
    vscode.commands.registerCommand('ewwBridge.setup', async () => {
      if (!readConfig().appId || !(await getAppSecret(context))) {
        const saved = await runCredentialSetup();
        if (!saved) {
          return;
        }
      }
      await startFeishu();
      const state = feishu?.connectionState() ?? 'stopped';
      let patchNote = '';
      const patchState = copilotPatchStatus();
      if (patchState.state === 'clean') {
        const patchNow = '打补丁';
        const choice = await vscode.window.showInformationMessage(
          '建议给内置 Copilot 打「即时落盘」补丁：长任务（后台命令）期间飞书卡片才能实时更新。',
          patchNow,
          '跳过',
        );
        if (choice === patchNow) {
          const outcome = applyCopilotPatch();
          patchNote = outcome.ok ? '已打补丁，重载窗口后生效' : `补丁失败：${outcome.message}`;
        }
      }
      if (!targetChatId()) {
        await vscode.window.showInformationMessage(
          '最后一步：在飞书里给机器人随便发一条消息。\n首次会自动信任你的账号并记住这个会话，之后直接发任务即可。',
        );
      }
      await vscode.window.showInformationMessage(
        [
          'EWW Bridge 设置完成',
          `飞书连接：${STATE_LABEL[state] ?? state}`,
          `推送会话：${targetChatId() || '等待飞书首条消息自动配对'}`,
          patchNote,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }),
    vscode.commands.registerCommand('ewwBridge.setCredentials', async () => {
      if (!(await runCredentialSetup())) {
        return;
      }
      await startFeishu();
      await vscode.window.showInformationMessage('凭据已保存，飞书长连接已启动。');
    }),
    vscode.commands.registerCommand('ewwBridge.connect', async () => {
      await startFeishu();
      const state = feishu?.connectionState();
      await vscode.window.showInformationMessage(
        feishu?.started
          ? `飞书长连接状态：${STATE_LABEL[state ?? 'idle'] ?? state}`
          : lastStartError || '未启动，请先设置 App ID / App Secret。',
      );
    }),
    vscode.commands.registerCommand('ewwBridge.disconnect', async () => {
      feishu?.stop();
      feishu = undefined;
      updateStatus();
      await vscode.window.showInformationMessage('飞书连接已断开。');
    }),
    vscode.commands.registerCommand('ewwBridge.setDefaultChat', async () => {
      const items: vscode.QuickPickItem[] = [];
      if (lastChatId) {
        items.push({ label: lastChatId, description: '最近收到消息的会话' });
      }
      if (readConfig().defaultChatId) {
        items.push({ label: readConfig().defaultChatId, description: '当前设置' });
      }
      items.push({ label: '$(edit) 手动输入 chat_id', description: 'oc_ 开头' });
      const picked = await vscode.window.showQuickPick(items, { title: '选择默认推送会话' });
      if (!picked) {
        return;
      }
      let chatId = picked.label;
      if (chatId.includes('手动输入')) {
        const input = await vscode.window.showInputBox({ title: 'chat_id', placeHolder: 'oc_xxxxxxxxxxxxxxxx', ignoreFocusOut: true });
        if (!input) {
          return;
        }
        chatId = input.trim();
      }
      await updateSetting('feishu.defaultChatId', chatId);
      updateStatus();
      await vscode.window.showInformationMessage(`默认推送会话已设置为 ${chatId}`);
    }),
    vscode.commands.registerCommand('ewwBridge.testSend', async () => {
      if (!feishu?.started) {
        await startFeishu();
      }
      if (!feishu?.started) {
        await vscode.window.showWarningMessage('飞书未连接，请先设置凭据。');
        return;
      }
      let chatId = targetChatId();
      if (!chatId) {
        chatId =
          (await vscode.window.showInputBox({ title: '推送目标 chat_id', placeHolder: 'oc_xxxxxxxxxxxxxxxx', ignoreFocusOut: true })) || '';
        if (!chatId) {
          return;
        }
        await updateSetting('feishu.defaultChatId', chatId);
        updateStatus();
      }
      await feishu.sendMarkdown(chatId, 'EWW Bridge 测试', `**连接正常**\n\n- 时间：${new Date().toLocaleString()}\n- 会话：${watcher?.getStatus().sessionId || '-'}`, 'green');
      await vscode.window.showInformationMessage('测试消息已发送。');
    }),
    vscode.commands.registerCommand('ewwBridge.followLatestSession', async () => {
      if (!watcher) {
        await vscode.window.showWarningMessage('未找到会话目录。');
        return;
      }
      const before = watcher.getStatus().sessionId;
      const after = watcher.forceFollowLatest() ?? '';
      if (after && after !== before) {
        log(`outbound: 手动切换到最新会话 ${after.slice(0, 8)}`);
        await vscode.window.showInformationMessage(`已切换到最新会话 ${after.slice(0, 8)}（发一条消息即可开始镜像）。`);
        updateStatus();
      } else {
        await vscode.window.showInformationMessage(`当前会话就是最新的（${(after || '-').slice(0, 8)}）。`);
      }
    }),
    vscode.commands.registerCommand('ewwBridge.pickSession', async () => {
      if (!transcript) {
        await vscode.window.showWarningMessage('未找到可跟随的对话目录。');
        return;
      }
      const agoText = (at: number): string => {
        const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
        if (sec < 90) return `${sec}s 前`;
        if (sec < 5400) return `${Math.round(sec / 60)} 分钟前`;
        if (sec < 172800) return `${Math.round(sec / 3600)} 小时前`;
        return `${Math.round(sec / 86400)} 天前`;
      };
      const current = transcript.currentSessionId;
      const pinned = transcript.pinnedFile;
      const sessions = transcript.listSessions(15);
      type SessionItem = vscode.QuickPickItem & {
        action: 'pin' | 'auto';
        file?: string;
        layout?: 'flat' | 'session-state';
      };
      const items: SessionItem[] = [
        {
          label: '$(sync) 自动跟随最新对话',
          description: pinned ? '当前为固定模式，选这项恢复自动' : '默认行为',
          action: 'auto',
        },
      ];
      for (const session of sessions) {
        const isCurrent = session.id === current;
        const isPinned = !!pinned && pinned === session.file;
        items.push({
          label: `${isCurrent || isPinned ? '$(check) ' : '$(comment-discussion) '}${
            session.title || session.id.slice(0, 8)
          }`,
          description: [
            session.layout === 'session-state' ? 'agent' : '经典',
            agoText(session.mtime),
            session.workspace ? path.basename(session.workspace) : '',
          ]
            .filter(Boolean)
            .join(' · '),
          detail: session.file,
          action: 'pin',
          file: session.file,
          layout: session.layout,
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: '选择要镜像的对话',
        placeHolder: `当前跟随：${current ? `${current.slice(0, 8)}${transcript.isAgentSession ? '（agent）' : ''}` : '未附加'}`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) {
        return;
      }
      if (picked.action === 'auto') {
        transcript.unpinSession();
        updateStatus();
        await vscode.window.showInformationMessage('已恢复自动跟随最新对话。');
        return;
      }
      if (picked.file && picked.layout) {
        transcript.pinSession(picked.file, picked.layout);
        updateStatus();
        await vscode.window.showInformationMessage(
          `已固定镜像：${picked.label.replace(/\$\([a-z-]+\)\s*/g, '')}（后续只同步这一段对话）`,
        );
      }
    }),
    vscode.commands.registerCommand('ewwBridge.pickChat', async () => {
      const agoText = (at: number): string => {
        const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
        if (sec < 90) return `${sec}s 前`;
        if (sec < 5400) return `${Math.round(sec / 60)} 分钟前`;
        if (sec < 172800) return `${Math.round(sec / 3600)} 小时前`;
        return `${Math.round(sec / 86400)} 天前`;
      };
      const bound = boundChatId();
      const fallback = readConfig().defaultChatId || lastChatId;
      type ChatItem = vscode.QuickPickItem & { action: 'pick' | 'manual' | 'unbind'; id?: string };
      const items: ChatItem[] = [];
      if (bound) {
        items.push({
          label: '$(circle-slash) 解除本工作区绑定',
          description: `当前绑定 ${bound}`,
          action: 'unbind',
        });
      }
      for (const entry of recentChats()) {
        items.push({
          label: `${entry.id === (bound || fallback) ? '$(check) ' : '$(comment) '}${entry.id}`,
          description: [agoText(entry.at), entry.workspace ? path.basename(entry.workspace) : '']
            .filter(Boolean)
            .join(' · '),
          action: 'pick',
          id: entry.id,
        });
      }
      items.push({ label: '$(edit) 手动输入 chat_id…', action: 'manual' });
      const picked = await vscode.window.showQuickPick(items, {
        title: '选择推送会话（记忆到当前工作区）',
        placeHolder: `当前使用：${targetChatId() || '未设置'}${bound ? '（本工作区绑定）' : ''}`,
        matchOnDescription: true,
      });
      if (!picked) {
        return;
      }
      if (picked.action === 'unbind') {
        bindChatToWorkspace('');
        await vscode.window.showInformationMessage(
          `已解除本工作区绑定，改用全局默认：${readConfig().defaultChatId || lastChatId || '未设置'}`,
        );
        return;
      }
      if (picked.action === 'manual') {
        const input = await vscode.window.showInputBox({
          title: '推送目标 chat_id',
          placeHolder: 'oc_xxxxxxxxxxxxxxxx',
          ignoreFocusOut: true,
        });
        if (!input) {
          return;
        }
        bindChatToWorkspace(input.trim());
        await vscode.window.showInformationMessage(`已绑定当前工作区 → ${input.trim()}`);
        return;
      }
      if (picked.id) {
        bindChatToWorkspace(picked.id);
        await vscode.window.showInformationMessage(`已绑定当前工作区 → ${picked.id}`);
      }
    }),
    vscode.commands.registerCommand('ewwBridge.dumpCurrentSession', async () => {
      if (!watcher) {
        await vscode.window.showWarningMessage('未找到会话目录。');
        return;
      }
      const summary = watcher.debugSummary();
      log('---- debug summary ----\n' + summary);
      initLog().show();
      await vscode.window.showInformationMessage('已把当前会话解析摘要写入日志。');
    }),
    vscode.commands.registerCommand('ewwBridge.injectTest', async () => {
      if (!watcher) {
        await vscode.window.showWarningMessage('未找到会话目录，无法注入。');
        return;
      }
      const text = await vscode.window.showInputBox({
        title: '模拟飞书下发（不经过飞书）',
        prompt: '输入后会追加到当前 Copilot 会话并自动提交',
        ignoreFocusOut: true,
      });
      if (!text) {
        return;
      }
      injector.enqueue({
        text,
        timeoutMs: readConfig().injectTimeoutMs,
        onInjected: () => void vscode.window.showInformationMessage('已提交到当前会话。'),
        onDeliveryFailed: () => void vscode.window.showWarningMessage('投递失败：请确认聊天面板已打开。'),
      });
    }),
    vscode.commands.registerCommand('ewwBridge.patchCopilotFlush', async () => {
      const outcome = applyCopilotPatch();
      log(`copilot patch: ${outcome.ok ? 'ok' : 'fail'} ${outcome.message}`);
      if (!outcome.ok) {
        const copy = '复制脚本命令';
        const open = '查看安装路径';
        const choice = await vscode.window.showErrorMessage(outcome.message, copy, open);
        if (choice === copy) {
          await vscode.env.clipboard.writeText(`node "${patchScriptPath()}" --path "${outcome.file || '<extension.js>'}"`);
          await vscode.window.showInformationMessage('命令已复制到剪贴板。');
        } else if (choice === open) {
          initLog().show();
        }
        return;
      }
      if (outcome.alreadyPatched) {
        await vscode.window.showInformationMessage(outcome.message);
        return;
      }
      const reload = '立即重载窗口';
      const choice = await vscode.window.showInformationMessage(outcome.message, reload);
      if (choice === reload) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
    vscode.commands.registerCommand('ewwBridge.restoreCopilotFlush', async () => {
      const outcome = restoreCopilotPatch();
      log(`copilot patch: restore ${outcome.ok ? 'ok' : 'fail'} ${outcome.message}`);
      if (outcome.ok) {
        const reload = '立即重载窗口';
        if ((await vscode.window.showInformationMessage(outcome.message, reload)) === reload) {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        await vscode.window.showWarningMessage(outcome.message);
      }
    }),
    vscode.commands.registerCommand('ewwBridge.compatCheck', async () => {
      const paths = resolveSessionPaths(context);
      const patchState = copilotPatchStatus();
      const copilotExt =
        vscode.extensions?.getExtension?.('GitHub.copilot') || vscode.extensions?.getExtension?.('GitHub.copilot-chat');
      const selfExt = vscode.extensions?.getExtension?.('huangdan.eww-bridge');
      const report = buildCompatReport({
        vscodeVersion: vscode.version,
        extensionVersion: (selfExt?.packageJSON as { version?: string } | undefined)?.version,
        copilotVersion: (copilotExt?.packageJSON as { version?: string } | undefined)?.version,
        patchState: patchState.state,
        patchFile: patchState.file,
        scriptPath: patchScriptPath(),
        chatSessionsDir: paths.chatSessionsDir,
        transcriptDir: paths.transcriptsDir,
        agentRoot: path.join(os.homedir(), '.copilot', 'session-state'),
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        sessionId: transcript?.currentSessionId,
        isAgentSession: transcript?.isAgentSession,
        quietMs: transcript?.quietMs,
      });
      log(`---- 兼容性自检 ----\n${report.lines.join('\n')}`);
      initLog().show();
      await vscode.window.showInformationMessage(
        report.ok
          ? '兼容性自检通过：当前版本组合的各项假设都成立。'
          : `兼容性自检发现 ${report.problems.length} 项：${report.problems.join('；')}（详情见日志）`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('ewwBridge')) {
        return;
      }
      if (event.affectsConfiguration('ewwBridge.feishu') || event.affectsConfiguration('ewwBridge.enabled')) {
        await startFeishu();
      }
      if (watcher) {
        watcher.partialIntervalMs = readConfig().streamingIntervalMs;
      }
      if (transcript) {
        transcript.partialIntervalMs = readConfig().streamingIntervalMs;
      }
      updateStatus();
    }),
  );

  await startFeishu();
  updateStatus();
  const statusTimer = setInterval(updateStatus, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

  // 首次使用提醒：没打补丁时正文要等很久才同步（只提示一次/每个 VS Code 版本）
  void (async () => {
    try {
      const patchState = copilotPatchStatus();
      const copilotExt =
        vscode.extensions?.getExtension?.('GitHub.copilot') || vscode.extensions?.getExtension?.('GitHub.copilot-chat');
      log(
        `compat: VS Code ${vscode.version || '?'} · Copilot ${
          (copilotExt?.packageJSON as { version?: string } | undefined)?.version || '?'
        } · 补丁 ${patchState.state}${patchState.file ? ` (${patchState.file})` : ''}`,
      );
      // 语言诊断：命令标题的中文来自 package.nls.<language>.json，语言对不上就只能显示英文
      try {
        const lang = uiLanguage();
        const nlsFile = context.extensionPath ? path.join(context.extensionPath, `package.nls.${lang}.json`) : '';
        log(
          `i18n: language=${lang} nls=${nlsFile ? (fs.existsSync(nlsFile) ? 'ok' : 'missing') : 'unknown'}` +
            `（界面中文但命令英文时，检查 argv.json 的 locale 与语言包版本）`,
        );
      } catch (error) {
        logError('i18n probe failed', error);
      }
      if (patchState.state !== 'clean') {
        return;
      }
      const hintKey = `copilotPatchHint:${vscode.version || 'unknown'}`;
      if (context.globalState.get<boolean>(hintKey)) {
        return;
      }
      const patch = '打补丁';
      const later = '稍后';
      const never = '本版本不再提示';
      const choice = await vscode.window.showInformationMessage(
        'EWW Bridge：VS Code 内置 Copilot 还没打“即时落盘”补丁，长任务时飞书卡片可能要等很久才更新。',
        patch,
        later,
        never,
      );
      if (choice === patch) {
        await vscode.commands.executeCommand('ewwBridge.patchCopilotFlush');
      } else if (choice === never) {
        await context.globalState.update(hintKey, true);
      }
    } catch (error) {
      logError('copilot patch hint failed', error);
    }
  })();
}

export function deactivate(): void {
  heartbeatCleanup?.();
  watcher?.stop();
  transcript?.stop();
  feishu?.stop();
  watcher = undefined;
  transcript = undefined;
  feishu = undefined;
}
