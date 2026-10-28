import * as vscode from 'vscode';
import { log } from '../log';

/**
 * 后台终端监视：Chat 里“把命令挂到后台、先给正文、等命令结束再唤醒”的时候，
 * transcript / chatSessions 在等待期间完全不落盘（实测：答案正文要等到唤醒才可见）。
 * VS Code 的 shell 执行事件是唯一实时的信号，用来：
 *   1. 把卡片状态改成「后台命令运行中 / 已结束」，而不是谎报“处理中”；
 *   2. 等待期间不做“静默收尾”；
 *   3. 等待期间不要让注入打断（唤醒会被取消）。
 */
export interface ShellActivity {
  command: string;
  terminalName: string;
  startedAt: number;
}

/** 认为“仍在等待”的最长时间：超过这个时长的常驻进程（dev server）不再算等待 */
const RECENT_MS = 10 * 60 * 1000;

export class TerminalWatch {
  private active = new Map<unknown, ShellActivity>();
  private disposables: vscode.Disposable[] = [];
  private supported = true;

  /** 后台命令开始/结束（用于立刻刷新卡片状态） */
  onChanged?: (activity: ShellActivity | undefined, exitCode?: number) => void;

  start(): void {
    const win = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (listener: (event: any) => void) => vscode.Disposable;
      onDidEndTerminalShellExecution?: (listener: (event: any) => void) => vscode.Disposable;
    };
    if (typeof win.onDidStartTerminalShellExecution !== 'function' || typeof win.onDidEndTerminalShellExecution !== 'function') {
      this.supported = false;
      log('terminal: 当前 VS Code 不支持 shell 执行事件，后台等待状态不可见');
      return;
    }
    try {
      this.disposables.push(
        win.onDidStartTerminalShellExecution((event) => {
          const raw = event?.execution?.commandLine;
          const command = typeof raw === 'string' ? raw : String(raw?.value ?? '');
          const activity: ShellActivity = {
            command: command.trim().split('\n')[0].slice(0, 120),
            terminalName: String(event?.terminal?.name ?? ''),
            startedAt: Date.now(),
          };
          this.active.set(event?.execution ?? activity, activity);
          log(`terminal: shell 开始 ${activity.command || '(空命令)'}`);
          this.onChanged?.(activity);
        }),
      );
      this.disposables.push(
        win.onDidEndTerminalShellExecution((event) => {
          const key = event?.execution;
          const activity = key ? this.active.get(key) : undefined;
          if (key) {
            this.active.delete(key);
          }
          const exitCode = typeof event?.exitCode === 'number' ? event.exitCode : undefined;
          log(`terminal: shell 结束 (exit=${exitCode ?? '?'}) ${activity?.command ?? ''}`);
          this.onChanged?.(this.current(), exitCode);
        }),
      );
    } catch (error) {
      this.supported = false;
      log('terminal: 订阅 shell 执行事件失败', String(error));
    }
  }

  dispose(): void {
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables = [];
    this.active.clear();
  }

  get isSupported(): boolean {
    return this.supported;
  }

  /** 最近 10 分钟内启动、且仍在执行的命令（常驻 dev server 超过 10 分钟就不再算“等待”） */
  current(): ShellActivity | undefined {
    const now = Date.now();
    let newest: ShellActivity | undefined;
    for (const [key, activity] of this.active) {
      if (now - activity.startedAt > RECENT_MS) {
        this.active.delete(key);
        continue;
      }
      if (!newest || activity.startedAt > newest.startedAt) {
        newest = activity;
      }
    }
    return newest;
  }

  hasRecent(): boolean {
    return !!this.current();
  }

  /** 正在执行的命令列表（调试/状态展示用） */
  list(): ShellActivity[] {
    this.current();
    return Array.from(this.active.values()).sort((a, b) => a.startedAt - b.startedAt);
  }
}
