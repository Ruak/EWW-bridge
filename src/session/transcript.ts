import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from '../log';

export interface StreamDelta {
  sessionId: string;
  thinking: string;
  text: string;
  tools: string[];
}

/**
 * 实时源：GitHub.copilot-chat/transcripts/<session>.jsonl
 *
 * 与 chatSessions 不同，transcript 在回合进行中就会持续追加：
 *   - assistant.message: { content, reasoningText, toolRequests }
 *   - tool.execution_start: { toolName }
 * 因此在长回合里也能拿到思考与正文，用于流式卡片。
 *
 * chatSessions 仍然负责：用户提问、回合结束（result）与最终权威文本。
 */
export class TranscriptWatcher {
  private timer?: NodeJS.Timeout;
  private file?: string;
  private sessionId = '';
  private offset = 0;
  private leftover = '';
  private thinking = '';
  private text = '';
  private tools: string[] = [];
  private dirty = false;
  private lastEmitAt = 0;
  private lastEventAt = 0;
  private emitCount = 0;
  private userPrompts = 0;
  private active = false;

  /** 最小推送间隔，由扩展按设置更新 */
  partialIntervalMs = 500;
  /** turn_end 后静默多久视为回合结束（毫秒） */
  softFinalIdleMs = 800;

  private turnEndedAt = 0;
  private softFinalSent = false;
  private settledAt = 0;
  private toolInFlightCount = 0;
  private lastLoggedTextLen = 0;

  onDelta?: (event: StreamDelta) => void;
  onSoftFinal?: (event: StreamDelta) => void;
  onUserPrompt?: (event: { sessionId: string; text: string }) => void;
  onSessionChange?: (sessionId: string) => void;
  /** 回合进行中收到了新的 user.message（后台终端通知 / steering / 手动新消息） */
  onInterrupt?: (content: string) => void;

  constructor(private readonly dir: string, private readonly pollMs = 200) {}

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get lastActivity(): number {
    return this.lastEventAt;
  }

  get deltaCount(): number {
    return this.emitCount;
  }

  /** 新用户提问条数（注入确认用，不用等模型产出） */
  get userPromptCount(): number {
    return this.userPrompts;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  /** 本轮是否已真正落定（turn_end 后静默超过阈值），仅作辅助信号 */
  get settled(): boolean {
    return this.settledAt > 0;
  }

  /** 正在执行的工具数（tool.execution_start/complete 配对） */
  get toolInFlight(): number {
    return this.toolInFlightCount;
  }

  /** 回合结束后清空累计，下一轮重新开始 */
  reset(): void {
    this.thinking = '';
    this.text = '';
    this.tools = [];
    this.dirty = false;
    this.lastEmitAt = 0;
    this.turnEndedAt = 0;
    this.softFinalSent = false;
    this.settledAt = 0;
    this.active = false;
    this.toolInFlightCount = 0;
  }

  private poll(): void {
    try {
      const newest = this.findNewest();
      if (!newest) {
        return;
      }
      if (newest !== this.file) {
        this.attach(newest);
        return;
      }
      this.readAppended();
      this.flush();
      this.maybeSoftFinal();
    } catch (error) {
      logError('transcript poll failed', error);
    }
  }

  private findNewest(): string | undefined {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    let best: { file: string; mtime: number } | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const full = path.join(this.dir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (!best || stat.mtimeMs > best.mtime) {
          best = { file: full, mtime: stat.mtimeMs };
        }
      } catch {
        /* 文件可能刚被替换 */
      }
    }
    return best?.file;
  }

  private attach(file: string): void {
    this.file = file;
    this.sessionId = path.basename(file, '.jsonl');
    this.leftover = '';
    this.reset();
    try {
      // 从文件末尾开始，避免把历史回合当成实时增量
      this.offset = fs.statSync(file).size;
    } catch {
      this.offset = 0;
    }
    log(`transcript: attached ${this.sessionId} (from end)`);
    this.onSessionChange?.(this.sessionId);
  }

  private readAppended(): void {
    if (!this.file) {
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size <= this.offset) {
      return;
    }
    const fd = fs.openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset = size;
      this.ingest(buffer.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  private ingest(text: string): void {
    this.leftover += text;
    const lines = this.leftover.split('\n');
    this.leftover = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.handle(event);
    }
  }

  private handle(event: any): void {
    const type = event?.type;
    const data = event?.data || {};
    if (type === 'session.start') {
      this.reset();
      return;
    }
    if (type === 'user.message') {
      const content = typeof data.content === 'string' ? data.content.trim() : '';
      // 后台终端通知（[Terminal ...]）是 VS Code 注入的 steering 消息：同一回合继续，不能当新提问处理
      if (content.startsWith('[Terminal ')) {
        this.lastEventAt = Date.now();
        return;
      }
      if (this.active) {
        this.onInterrupt?.(content);
      }
      if (content) {
        this.userPrompts += 1;
        this.onUserPrompt?.({ sessionId: this.sessionId, text: content });
      }
      // 新回合开始：清空上一轮累计，避免新卡片带上旧内容
      this.thinking = '';
      this.text = '';
      this.tools = [];
      this.dirty = false;
      this.lastEmitAt = 0;
      this.active = true;
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
      this.toolInFlightCount = 0;
      this.lastLoggedTextLen = 0;
      this.lastEventAt = Date.now();
      return;
    }
    if (type === 'assistant.turn_start') {
      this.active = true;
      this.settledAt = 0;
      return;
    }
    if (type === 'assistant.message') {
      const reasoning = typeof data.reasoningText === 'string' ? data.reasoningText.trim() : '';
      const content = typeof data.content === 'string' ? data.content.trim() : '';
      if (reasoning) {
        this.appendThinking(reasoning);
      }
      if (content) {
        this.appendText(content);
      }
      const toolRequests: any[] = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      for (const request of toolRequests) {
        if (request && typeof request.name === 'string') {
          this.pushTool(request.name);
        }
      }
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'tool.execution_start') {
      if (typeof data.toolName === 'string') {
        this.pushTool(data.toolName);
      }
      this.toolInFlightCount += 1;
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'tool.execution_complete') {
      this.toolInFlightCount = Math.max(0, this.toolInFlightCount - 1);
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'assistant.turn_end') {
      // 每条模型消息结束都会触发；若后续没有工具/新消息，则视为回合结束
      this.turnEndedAt = Date.now();
    } else {
      return;
    }
    this.lastEventAt = Date.now();
    this.dirty = true;
  }

  private maybeSoftFinal(): void {
    if (!this.turnEndedAt || this.softFinalSent) {
      return;
    }
    if (Date.now() - this.turnEndedAt < this.softFinalIdleMs) {
      return;
    }
    this.settledAt = Date.now();
    this.softFinalSent = true;
    this.active = false;
    if (!this.thinking && !this.text && this.tools.length === 0) {
      return;
    }
    this.onSoftFinal?.({
      sessionId: this.sessionId,
      thinking: this.thinking,
      text: this.text,
      tools: [...this.tools],
    });
  }

  private appendThinking(chunk: string): void {
    this.thinking = capTail(`${this.thinking}${this.thinking ? '\n\n' : ''}${chunk}`, 20000);
  }

  private appendText(chunk: string): void {
    this.text = capTail(`${this.text}${this.text ? '\n\n' : ''}${chunk}`, 20000);
  }

  private pushTool(name: string): void {
    if (this.tools[this.tools.length - 1] === name) {
      return;
    }
    this.tools.push(name);
    if (this.tools.length > 20) {
      this.tools.shift();
    }
  }

  private flush(): void {
    if (!this.dirty || (!this.thinking && !this.text && this.tools.length === 0)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastEmitAt < this.partialIntervalMs) {
      return;
    }
    this.lastEmitAt = now;
    this.dirty = false;
    this.emitCount += 1;
    if (Math.abs(this.text.length - this.lastLoggedTextLen) >= 80) {
      this.lastLoggedTextLen = this.text.length;
      log(`transcript: 正文累计 ${this.text.length}ch（增量#${this.emitCount}）`);
    }
    this.onDelta?.({
      sessionId: this.sessionId,
      thinking: this.thinking,
      text: this.text,
      tools: [...this.tools],
    });
  }
}

function capTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
