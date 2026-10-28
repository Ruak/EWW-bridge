import * as vscode from 'vscode';
import {
  getAppSecret,
  readConfig,
  STATE_LAST_CHAT_ID,
  storeAppSecret,
  updateSetting,
} from './config';
import { FeishuAdapter, InboundMessage } from './feishu/adapter';
import { buildStreamingCards, splitMarkdown } from './feishu/card';
import type { CardPair } from './feishu/card';
import { Injector } from './injector';
import { initLog, log, logError } from './log';
import { createTranscriptWatcher, createWatcher } from './session/store';
import { SessionWatcher } from './session/watcher';
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog();
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

  // 卡片出现真实内容/工具进展的时间，作为“注入已生效”的确认信号（占位心跳不算）
  let lastContentActivityAt = 0;
  const injector = new Injector(watcher, transcript, () => lastContentActivityAt);
  let lastChatId: string = context.globalState.get<string>(STATE_LAST_CHAT_ID, '') || '';

  const echoQueue: { text: string; at: number }[] = [];
  const rate = new Map<string, number[]>();
  /** transcript 已即时镜像过的提问，避免 chatSessions 迟到后再发一次 */
  const seenUserPrompts = new Map<string, number>();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'ewwBridge.showStatus';
  status.show();
  context.subscriptions.push(status);

  const targetChatId = () => readConfig().defaultChatId || lastChatId;

  const statusText = (): string => {
    const snapshot = watcher?.getStatus();
    const state = feishu?.connectionState() ?? 'stopped';
    return [
      `连接: ${STATE_LABEL[state] ?? state}`,
      `会话: ${snapshot?.sessionId || '-'}`,
      `请求数: ${snapshot?.requests ?? 0}`,
      `忙碌: ${snapshot?.busy ? '是' : '否'}`,
      `注入队列: ${injector.pending}`,
      `推送目标: ${targetChatId() || '未设置'}`,
      `注入方式: ${readConfig().newChat ? '每次新会话' : '追加当前会话'}`,
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
    chatId: string;
    messageId?: string;
    creating?: Promise<string | undefined>;
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
  }
  const activeStreams = new Map<string, TurnStream>();
  const finalized = new Map<string, string>();
  const STREAM_STATE_KEY = 'ewwBridge.streamCard';
  const saveStreamState = (sessionId: string, messageId: string, requestIndex?: number): void => {
    void context.workspaceState.update(STREAM_STATE_KEY, { sessionId, messageId, requestIndex, updatedAt: Date.now() });
  };
  const clearStreamState = (): void => {
    void context.workspaceState.update(STREAM_STATE_KEY, undefined);
  };
  // 重载时恢复未完成的流式卡片，避免另开一张卡导致"内容被截断"
  let pendingReplayIndex: number | undefined;
  const restored = context.workspaceState.get<{ sessionId: string; messageId: string; requestIndex?: number }>(STREAM_STATE_KEY);
  if (restored && watcher?.getStatus().sessionId === restored.sessionId) {
    if (watcher?.startedMidTurn) {
      activeStreams.set(restored.sessionId, {
        chatId: targetChatId() || '',
        messageId: restored.messageId,
        createFailures: 0,
        patches: 1,
        lastRendered: '',
        lastPatchAt: Date.now(),
        turnStartedAt: 0,
        requestIndex: restored.requestIndex,
      });
      log(`outbound: 恢复上次的流式卡片 ${restored.messageId} (request #${restored.requestIndex ?? '?'})`);
    } else {
      // 回合可能刚好在重载前结束，但上次实例没来得及定稿：重放最后一条结果补全同一张卡
      const status = watcher?.getStatus();
      if (status && status.requests > 0) {
        const lastIndex = status.requests - 1;
        activeStreams.set(restored.sessionId, {
          chatId: targetChatId() || '',
          messageId: restored.messageId,
          createFailures: 0,
          patches: 1,
          lastRendered: '',
          lastPatchAt: Date.now(),
          turnStartedAt: 0,
          requestIndex: lastIndex,
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

  // 正文多源合并：agent 模式下 transcript 正文稀疏，chatSessions 的 response 可能更长
  const mergedAnswer = (fallback: string): string => {
    const sessionText = watcher?.latestAnswerText() ?? '';
    return sessionText.length > (fallback || '').length ? sessionText : fallback;
  };

  const cardTools = (config: ReturnType<typeof readConfig>, tools: string[]): string[] =>
    config.forwardTools ? tools : config.forwardProgress ? tools.slice(-3) : [];

  const pushStreamCard = async (sessionId: string, chatId: string, cards: CardPair): Promise<TurnStream> => {
    let state = activeStreams.get(sessionId);
    if (!state) {
      state = { chatId, createFailures: 0, patches: 0, lastRendered: '', lastPatchAt: Date.now(), turnStartedAt: 0 };
      activeStreams.set(sessionId, state);
      log(`outbound: stream card for ${sessionId.slice(0, 8)}`);
    }
    if (!state.messageId && !state.creating && feishu?.started && state.createFailures < 3) {
      state.creating = feishu.sendCardPair(chatId, cards);
    }
    if (state.creating) {
      const messageId = await state.creating;
      state.creating = undefined;
      state.messageId = messageId;
      if (!messageId) {
        state.createFailures += 1;
        log(`outbound: 卡片创建失败（第 ${state.createFailures} 次）`);
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
      if (state.patches <= 3 || state.patches % 10 === 0) {
        log(`outbound: stream patch=${state.patches} (+${Date.now() - startedAt}ms, ${cards.v2.length}ch)`);
      }
    } else {
      log(`outbound: stream patch FAIL #${state.messageId.slice(-8)} (${cards.v2.length}ch)`);
    }
  };

  // 同一张卡只允许一个在途 patch：期间新帧只保留最新一帧，避免并发/乱序与堆积
  const queueStreamCard = (state: TurnStream, cards: CardPair): Promise<void> => {
    state.pendingPatch = cards;
    if (state.patching) {
      return state.patching;
    }
    state.patching = (async () => {
      try {
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
      if (!state || state.doneAt || state.softFinalText) {
        stopHeartbeat(sessionId);
        return;
      }
      const secs = Math.max(1, Math.round((Date.now() - since) / 1000));
      const cards = buildStreamingCards({
        title: 'Copilot · 处理中…',
        tools: state.lastTools ?? [],
        answer: state.lastAnswerText ?? '',
        status: `进行中…（已等待 ${secs}s）`,
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
    }, 10000);
    heartbeats.set(sessionId, timer);
  };
  heartbeatCleanup = () => {
    for (const timer of heartbeats.values()) {
      clearInterval(timer);
    }
    heartbeats.clear();
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
      stopHeartbeat(event.sessionId);
      lastContentActivityAt = Date.now();
      if (!config.forwardAssistant || !config.forwardStreaming) {
        return;
      }
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      const state = activeStreams.get(event.sessionId);
      const softAnswer = mergedAnswer(event.text);
      if (state) {
        if (state.doneAt && normalize(state.softFinalText ?? '') === normalize(softAnswer)) {
          return;
        }
        state.softFinalText = softAnswer;
        state.lastAnswerText = softAnswer;
        state.lastTools = event.tools;
      }
      const cards = buildStreamingCards({
        title: 'Copilot',
        thinking: config.forwardThinking ? event.thinking : '',
        tools: cardTools(config, event.tools),
        answer: softAnswer || '（本轮没有文字输出）',
        expanded: false,
        showThinking: config.forwardThinking,
        thinkingLimit: 6000,
        answerLimit: 12000,
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
            await pushStreamCard(event.sessionId, chatId, cards);
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
      // 刚注入时建的占位卡就是这一轮自己的，不能当成"上一轮"清掉，否则会另建第二张卡
      const placeholderForThisPrompt =
        !!previous &&
        !previous.doneAt &&
        !previous.softFinalText &&
        previous.requestIndex === undefined &&
        Date.now() - previous.lastPatchAt < 60000;
      if (previous && !placeholderForThisPrompt && previous.softFinalText) {
        // 上一轮已定稿，直接丢弃状态，新回合会新建卡片
        activeStreams.delete(event.sessionId);
      } else if (previous && !placeholderForThisPrompt) {
        if (previous.messageId) {
          void feishu?.patchCardPair(
            previous.messageId,
            buildStreamingCards({
              title: 'Copilot · 已结束',
              status: '新一轮已开始，本轮到此为止',
              expanded: false,
            }),
          );
        }
        stopHeartbeat(event.sessionId);
        activeStreams.delete(event.sessionId);
      }
      lastTurnStartedAt.set(event.sessionId, Date.now());
      const config = readConfig();
      if (!config.forwardUser) {
        return;
      }
      if (event.text.startsWith('[Terminal ')) {
        log('outbound: skip terminal notification prompt');
        return;
      }
      if (consumeEcho(event.text)) {
        return;
      }
      const chatId = targetChatId();
      if (!chatId || !feishu?.started) {
        return;
      }
      const normalized = normalize(event.text);
      const mirroredAt = seenUserPrompts.get(normalized);
      if (mirroredAt && Date.now() - mirroredAt < 120000) {
        return;
      }
      seenUserPrompts.set(normalized, Date.now());
      if (seenUserPrompts.size > 50) {
        const oldest = seenUserPrompts.keys().next().value;
        if (oldest) {
          seenUserPrompts.delete(oldest);
        }
      }
      log(`outbound: user prompt via transcript (${event.text.length}ch)`);
      void feishu.sendMarkdown(chatId, '你 · VS Code', event.text, 'grey', true);
    };

    transcript.onDelta = (event) => {
      const config = readConfig();
      if (event.text.trim()) {
        stopHeartbeat(event.sessionId);
      }
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
          const cards = buildStreamingCards({
            title: 'Copilot · 处理中…',
            thinking: config.forwardThinking ? event.thinking : '',
            answer: mergedAnswer(event.text),
            tools: cardTools(config, event.tools),
            status: '正在输出…',
            expanded: false,
            showThinking: config.forwardThinking,
          });
          const existing = activeStreams.get(event.sessionId);
          if (existing) {
            existing.lastAnswerText = mergedAnswer(event.text);
            existing.lastTools = event.tools;
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
  }

  if (watcher) {
    watcher.onUser = (event) => {
      const config = readConfig();
      if (event.text.startsWith('[Terminal ')) {
        log('outbound: skip terminal notification user message');
        return;
      }
      lastTurnStartedAt.set(event.sessionId, event.timestamp || Date.now());
      let stream = activeStreams.get(event.sessionId);
      if (stream && stream.requestIndex !== undefined && stream.requestIndex !== event.index) {
        // 新一轮：上一轮的卡片已完成，释放状态，本轮重新建卡
        stopHeartbeat(event.sessionId);
        activeStreams.delete(event.sessionId);
        clearStreamState();
        stream = undefined;
      }
      if (stream) {
        stream.requestIndex = event.index;
        if (!stream.turnStartedAt) {
          stream.turnStartedAt = event.timestamp || Date.now();
        }
        if (stream.messageId) {
          saveStreamState(event.sessionId, stream.messageId, stream.requestIndex);
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
        void feishu.sendMarkdown(chatId, '你 · VS Code', event.text, 'grey', true);
      }
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
        );
      }
    };

    // 兜底：transcript 不可用（或尚未产生增量）时，用 chatSessions 的增量
    watcher.onPartial = (event) => {
      const config = readConfig();
      if (!config.forwardAssistant || !config.forwardStreaming) {
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
          const cards = buildStreamingCards({
            title: 'Copilot · 处理中…',
            thinking: config.forwardThinking ? event.thinking : '',
            answer: mergedAnswer(event.text),
            tools: cardTools(config, event.tools),
            status: '正在输出…',
            expanded: false,
            showThinking: config.forwardThinking,
          });
          const state = await pushStreamCard(event.sessionId, chatId, cards);
          state.lastAnswerText = mergedAnswer(event.text);
          state.lastTools = event.tools;
          await queueStreamCard(state, cards);
        } catch (error) {
          logError('outbound partial failed', error);
        }
      })();
    };

    watcher.onAssistant = (event) => {
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
      const elapsed =
        typeof event.elapsedMs === 'number' && event.elapsedMs > 0 ? `${Math.round(event.elapsedMs / 1000)}s` : '';
      const footer = [modelShort, elapsed].filter(Boolean).join(' · ');
      // chatSessions 批量落盘有空窗：文本为空但已有思考/工具时，这不是终稿，继续等完整结果
      const waitingMore =
        !event.text.trim() && !aborted && (event.thinking.trim().length > 0 || event.tools.length > 0);
      const answerText = waitingMore
        ? ''
        : event.text || (aborted ? '（本轮在 VS Code 侧被中断，未产生文字输出）' : '（本轮没有文字输出）');
      const chunks = splitMarkdown(answerText);
      const firstChunk = chunks.shift() ?? '';
      const cards = buildStreamingCards({
        title: aborted ? 'Copilot · 已中断' : 'Copilot',
        thinking: config.forwardThinking ? event.thinking : '',
        tools: cardTools(config, event.tools),
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
      const state = activeStreams.get(event.sessionId);
      const startedAt = state?.turnStartedAt || lastTurnStartedAt.get(event.sessionId) || 0;
      const staleByIndex = state?.requestIndex !== undefined && state.requestIndex !== event.index;
      const staleByTime = startedAt > 0 && (event.timestamp ?? 0) + 5000 < startedAt;
      if (state && (staleByIndex || staleByTime)) {
        log(`outbound: 丢弃迟到结果 #${event.index}（卡片属于 #${state.requestIndex ?? '?'}）`);
        return;
      }
      if (!state && staleByTime) {
        log(`outbound: 丢弃无主迟到结果 #${event.index}`);
        return;
      }
      if (state && state.requestIndex === undefined) {
        state.requestIndex = event.index;
      }
      if (state) {
        state.lastAnswerText = event.text;
        state.lastTools = event.tools;
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
    watcher?.replayLast(pendingReplayIndex);
    pendingReplayIndex = undefined;
  }

  // ---------------- 入站：飞书 -> 当前会话 ----------------
  const handleInbound = async (message: InboundMessage): Promise<void> => {
    const reply = (text: string) => feishu?.sendText(message.chatId, text);
    if (!readConfig().defaultChatId && message.chatId) {
      lastChatId = message.chatId;
      await context.globalState.update(STATE_LAST_CHAT_ID, message.chatId);
      updateStatus();
    }

    const config = readConfig();
    if (config.allowedOpenIds.length === 0) {
      await reply(`未配置白名单，已拒绝。\n你的 open_id：${message.openId}\n请加入设置 ewwBridge.security.allowedOpenIds`);
      log(`inbound rejected (empty allowlist) open_id=${message.openId}`);
      return;
    }
    if (!config.allowedOpenIds.includes(message.openId)) {
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
          const sessionId = watcher?.getStatus().sessionId;
          if (streamChatId && sessionId) {
            const previous = activeStreams.get(sessionId);
            if (previous?.doneAt) {
              // 上一轮已定稿：释放卡片状态，本轮重新建卡
              activeStreams.delete(sessionId);
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
            );
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
  context.subscriptions.push(
    vscode.commands.registerCommand('ewwBridge.showLogs', () => initLog().show()),
    vscode.commands.registerCommand('ewwBridge.showStatus', async () => {
      await vscode.window.showInformationMessage('EWW Bridge', { modal: true, detail: statusText() }, '打开日志');
    }),
    vscode.commands.registerCommand('ewwBridge.setCredentials', async () => {
      const current = readConfig();
      const appId = await vscode.window.showInputBox({
        title: '飞书自建应用 · App ID',
        value: current.appId,
        ignoreFocusOut: true,
        placeHolder: 'cli_xxxxxxxxxxxxxxxx',
      });
      if (!appId) {
        return;
      }
      const appSecret = await vscode.window.showInputBox({
        title: '飞书自建应用 · App Secret',
        password: true,
        ignoreFocusOut: true,
        placeHolder: '输入后存入 VS Code 密钥库',
      });
      if (!appSecret) {
        return;
      }
      await storeAppSecret(context, appSecret);
      await updateSetting('feishu.appId', appId.trim());
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
