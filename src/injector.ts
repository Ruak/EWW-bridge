import * as vscode from 'vscode';
import { readConfig } from './config';
import { log, logError } from './log';
import { SessionWatcher } from './session/watcher';
import { TranscriptWatcher } from './session/transcript';

export interface InjectTask {
  text: string;
  timeoutMs: number;
  onInjected?: () => void;
  onDeliveryFailed?: () => void;
  onAborted?: () => void;
  onTimeout?: () => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 入站注入：调用 workbench.action.chat.open {query, isPartialQuery:false}
 * 会把消息追加到当前聊天面板的活跃会话，并自动提交。
 */
export class Injector {
  private queue: InjectTask[] = [];
  private running = false;
  private warmed = false;

  constructor(
    private readonly watcher: SessionWatcher | undefined,
    private readonly transcript?: TranscriptWatcher,
    /** 出站卡片最近一次成功发送/更新的时间（证明回合已经真的开始） */
    private readonly activity?: () => number,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.running;
  }

  enqueue(task: InjectTask): number {
    const duplicate = this.queue.some((item) => item.text === task.text);
    if (duplicate) {
      log(`inject: 忽略重复任务（已在队列/执行中）"${task.text.slice(0, 40)}"`);
      return this.queue.length;
    }
    this.queue.push(task);
    log(`inject: queued (${this.queue.length} pending) "${task.text.slice(0, 60)}"`);
    void this.pump();
    return this.queue.length;
  }

  /** 清空尚未开始的任务（正在执行的那条不受影响） */
  clearQueue(): number {
    const count = Math.max(0, this.queue.length - (this.running ? 1 : 0));
    this.queue = this.running ? this.queue.slice(0, 1) : [];
    log(`inject: cleared ${count} pending tasks`);
    return count;
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    const task = this.queue[0];
    if (!task) {
      return;
    }
    this.running = true;
    let keepQueued = false;
    try {
      // 上一轮没真正结束时绝不能投：提交会在 VS Code 侧打断正在输出的回合，重载后就只剩残段
      const idle = await this.waitUntilIdle(task.timeoutMs);
      if (!idle) {
        keepQueued = true;
        log('inject: 回合仍在运行，任务继续排队（不打断当前输出）');
        return;
      }
      const config = readConfig();
      const assistantBefore = this.watcher?.assistantMessages ?? 0;
      if (config.newChat) {
        await vscode.commands.executeCommand('workbench.action.chat.newChat');
        await delay(400);
      }
      const statusBefore = this.watcher?.getStatus();
      const deltaBefore = this.transcript?.deltaCount ?? 0;
      const promptBefore = this.transcript?.userPromptCount ?? 0;
      const startedAt = Date.now();
      await this.submit(task.text);
      task.onInjected?.();
      // 只投一次：确认窗口给足（网页视图节流时提交可能迟到几十秒）
      const delivered = await this.waitForTurnStarted(
        statusBefore?.sessionId ?? '',
        statusBefore?.requests ?? 0,
        deltaBefore,
        promptBefore,
        startedAt,
        45000,
      );
      if (delivered) {
        log(`inject: 回合已开始（+${Date.now() - startedAt}ms）`);
      }
      if (!delivered) {
        // 不再自动重投：自动重投会在上一轮结束时造成两条相同提问
        log('inject: 45s 内未确认，已停止自动重投（避免重复消息）');
        task.onDeliveryFailed?.();
      } else {
        log('inject: submitted to active chat');
        const outcome = await this.waitForTurnEnd(assistantBefore, statusBefore?.requests ?? 0, task.timeoutMs);
        if (outcome === 'timeout') {
          task.onTimeout?.();
          log('inject: timeout waiting for turn completion');
        } else if (outcome === 'ended') {
          task.onAborted?.();
          log('inject: turn ended without assistant message (可能被中断)');
        }
      }
    } catch (error) {
      logError('inject failed', error);
      task.onDeliveryFailed?.();
    } finally {
      this.running = false;
      if (keepQueued) {
        setTimeout(() => void this.pump(), 5000);
      } else {
        this.queue.shift();
        setTimeout(() => void this.pump(), 250);
      }
    }
  }

  private async submit(text: string): Promise<void> {
    if (!this.warmed) {
      // 重载后聊天 webview 尚未创建，直接 chat.open 可能静默失败：先空提交一次把视图/输入框拉起来
      this.warmed = true;
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: '', isPartialQuery: true });
        await delay(700);
      } catch {
        /* 忽略 */
      }
    }
    // 面板隐藏时 chat.open 可能只填不提交：先聚焦聊天输入框，再带 query 提交
    try {
      await vscode.commands.executeCommand('workbench.action.chat.focusInput');
      await delay(150);
    } catch {
      /* 聊天视图不可聚焦时忽略 */
    }
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: text,
        isPartialQuery: false,
      });
      return;
    } catch (error) {
      log('inject: chat.open 提交失败，改用输入框提交', String(error));
    }
    // 仅当命令本身报错时才走兜底，不做“未确认就重投”
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: text,
        isPartialQuery: true,
      });
      await delay(400);
      await vscode.commands.executeCommand('workbench.action.chat.focusInput');
      await vscode.commands.executeCommand('workbench.action.chat.submit');
      return;
    } catch (error) {
      log('inject: 输入框提交失败，改用 submitWithoutDispatching', String(error));
    }
    await vscode.commands.executeCommand('workbench.action.chat.submitWithoutDispatching', {
      inputValue: text,
    });
    try {
      await vscode.commands.executeCommand('workbench.action.chat.submit');
    } catch {
      /* 忽略：部分版本无此命令 */
    }
  }

  private async waitUntilIdle(maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    let lastLogAt = 0;
    while (Date.now() < deadline) {
      const watcherBusy = this.watcher?.isBusy() ?? false;
      const transcriptBusy = this.transcript?.isTurnRunning() ?? false;
      const quiet = this.transcript?.quietMs ?? Number.MAX_SAFE_INTEGER;
      // 判定依次收紧：chatSessions 落盘滞后，以 transcript 的 turn_start/turn_end + 在途工具为准；
      // transcript 长静默（>30s）时不再理会 chatSessions 的 isBusy（它可能只是没落盘）
      if (!transcriptBusy && quiet > 2000 && (!watcherBusy || quiet > 30000)) {
        return true;
      }
      if (Date.now() - lastLogAt > 15000) {
        lastLogAt = Date.now();
        log(
          `inject: 等待回合结束（chatSessions 忙=${watcherBusy}，transcript 运行中=${transcriptBusy}，静默 ${Math.round(
            Math.min(quiet, 999999) / 1000,
          )}s）`,
        );
      }
      await delay(300);
    }
    return false;
  }

  /** 注入后确认真的开始了新回合：chatSessions 新请求 或 transcript 出现新事件 */
  private async waitForTurnStarted(
    sessionIdBefore: string,
    requestsBefore: number,
    deltaCountBefore: number,
    promptCountBefore: number,
    activityAfter: number,
    maxMs: number,
  ): Promise<boolean> {
    if (!this.watcher && !this.transcript) {
      return true;
    }
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const status = this.watcher?.getStatus();
      if (status && (status.sessionId !== sessionIdBefore || status.requests > requestsBefore)) {
        return true;
      }
      if (this.transcript) {
        // transcript 会先写 user.message，不必等模型吐字
        if (this.transcript.userPromptCount > promptCountBefore) {
          return true;
        }
        if (this.transcript.deltaCount > deltaCountBefore || this.transcript.lastActivity >= activityAfter) {
          return true;
        }
      }
      // 卡片已经出现内容（说明回合肯定开始了），即使 chatSessions/transcript 还没落盘
      if (this.activity && this.activity() >= activityAfter) {
        return true;
      }
      await delay(150);
    }
    return false;
  }

  /**
   * 等待本轮结束。三种结果：
   * - completed：产生了助手消息，或 transcript 已落定（turn_end + 静默、无在途工具）
   * - ended：该请求被中断（aborted），立即放行队列
   * - timeout：超过配置时长
   *
   * 注意：chatSessions 的 result 落盘会晚几十秒，不能作为唯一判据，
   * 否则队列只能“等超时”才知道结束。transcript 是实时源，优先用它。
   */
  private async waitForTurnEnd(
    assistantCountBefore: number,
    requestsBefore: number,
    timeoutMs: number,
  ): Promise<'completed' | 'ended' | 'timeout'> {
    if (!this.watcher && !this.transcript) {
      return 'completed';
    }
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let sawActivity = false;
    while (Date.now() < deadline) {
      if (this.watcher && this.watcher.assistantMessages > assistantCountBefore) {
        return 'completed';
      }
      const status = this.watcher?.getStatus();
      if (this.watcher && status && status.requests > requestsBefore) {
        const latest = this.watcher.latestStatus();
        if (latest === 'aborted') {
          return 'ended';
        }
        if (latest === 'completed') {
          return 'completed';
        }
      }
      if (this.transcript) {
        if (this.transcript.lastActivity >= startedAt || this.transcript.settledAtMs >= startedAt) {
          sawActivity = true;
        }
        // transcript 是实时源：turn 闭合 + 无在途工具 + 静默 3s 就是真结束，不必等 chatSessions 的 result
        if (sawActivity && !this.transcript.isTurnRunning() && this.transcript.quietMs > 3000) {
          log(`inject: transcript 已落定（静默 ${Math.round(this.transcript.quietMs / 1000)}s），本轮结束`);
          return 'completed';
        }
      } else if (status && !status.busy && Date.now() - startedAt > 300000) {
        log('inject: 新请求 5 分钟无任何动静，判定为已结束');
        return 'ended';
      }
      await delay(300);
    }
    return 'timeout';
  }
}
