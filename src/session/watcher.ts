import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { log, logError } from '../log';
import {
  applyPatch,
  applyPatchLenient,
  extractText,
  extractThinking,
  extractTools,
  isRequestAborted,
  isRequestComplete,
  requestText,
  SessionState,
} from './parser';

export interface UserEvent {
  sessionId: string;
  index: number;
  requestId: string;
  text: string;
  timestamp: number;
}

export interface AssistantEvent {
  sessionId: string;
  index: number;
  requestId: string;
  text: string;
  tools: string[];
  thinking: string;
  complete: boolean;
  /** 请求开始时间（毫秒） */
  timestamp?: number;
  /** VS Code 侧被取消 / 无 result 的异常结束 */
  aborted?: boolean;
  /** 模型标识（如 deepseek/deepseek-flash） */
  modelId?: string;
  /** 本轮耗时（毫秒） */
  elapsedMs?: number;
}

export interface WatcherStatus {
  sessionId: string;
  file?: string;
  requests: number;
  busy: boolean;
  lastChange: number;
}

/**
 * 轮询 chatSessions/*.jsonl，增量应用补丁并产出用户/助手的消息事件。
 *
 * 设计取舍：
 * - 只跟随"最近被写入"的会话文件（即当前活跃会话），避免多会话串台
 * - 首次附加时建立基线，不回放历史
 * - 回合结束以 requests[i].result / elapsedMs 为准，另加空闲兜底
 */
export class SessionWatcher {
  private timer?: NodeJS.Timeout;
  private file?: string;
  private sessionId = '';
  private offset = 0;
  private leftover = '';
  private state?: SessionState;
  private seenRequests = 0;
  private emitted = new Map<number, string>();
  private completed = new Set<number>();
  private completedCount = 0;
  private assistantCount = 0;
  private lastChange = 0;
  private lastPartialAt = new Map<number, number>();
  private lastPartialSig = new Map<number, string>();
  /** 激活/重载时是否已经有一个未完成的回合（避免把中途 tail 当成完整流式） */
  private baselineIncomplete = false;
  private lastCompact = 0;
  private lastPatchErrorLog = 0;
  /** 尾部解析模式：允许补丁路径自动创建 */
  private lenient = false;

  /** 流式预览的最小间隔（毫秒），由扩展按设置更新 */
  partialIntervalMs = 800;
  /** 无 result 字段时的空闲兜底阈值（毫秒） */
  idleFallbackMs = 120000;

  onUser?: (event: UserEvent) => void;
  onAssistant?: (event: AssistantEvent) => void;
  /** 回合结束前的增量内容（思考 / 已生成的回答 / 工具） */
  onPartial?: (event: AssistantEvent) => void;

  constructor(private readonly chatSessionsDir: string, private readonly pollMs = 300) {}

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

  get completedTurns(): number {
    return this.completedCount;
  }

  /** 激活时是否已处于某个回合中途 */
  get startedMidTurn(): boolean {
    return this.baselineIncomplete;
  }

  /** 跨会话累计的助手消息数，用于注入后判断“是否真的产生了回答” */
  get assistantMessages(): number {
    return this.assistantCount;
  }

  isBusy(): boolean {
    const requests = this.state?.requests;
    if (!requests || requests.length === 0) {
      return false;
    }
    return !isRequestComplete(requests[requests.length - 1]);
  }

  /** 最近一个非系统请求的正文（agent 模式下 transcript 正文稀疏，用它补充） */
  latestAnswerText(): string {
    const requests = this.state?.requests ?? [];
    for (let i = requests.length - 1; i >= 0; i--) {
      const request = requests[i];
      if (!request) {
        continue;
      }
      if (requestText(request).startsWith('[Terminal ')) {
        continue;
      }
      const text = extractText(request.response);
      if (text) {
        return text;
      }
    }
    return '';
  }

  getStatus(): WatcherStatus {
    return {
      sessionId: this.sessionId,
      file: this.file,
      requests: this.state?.requests.length ?? 0,
      busy: this.isBusy(),
      lastChange: this.lastChange,
    };
  }

  /** 重载后重发指定已完成回合（用于补全上次未定稿的卡片） */
  replayLast(index: number): void {
    if (!this.state || index < 0 || index >= this.state.requests.length) {
      return;
    }
    this.emitted.delete(index);
    this.completed.delete(index);
    this.afterIngest();
  }

  /** 调试用：输出当前会话各回合的解析结果摘要 */
  debugSummary(): string {
    const requests = this.state?.requests ?? [];
    const lines = [
      `session: ${this.sessionId || '-'}`,
      `file: ${this.file || '-'}`,
      `requests: ${requests.length}`,
      `busy: ${this.isBusy()}`,
      `completed: ${this.completedCount}`,
    ];
    requests.forEach((request, index) => {
      if (!request) {
        return;
      }
      lines.push(
        `#${index} complete=${isRequestComplete(request)} user=${requestText(request).length}ch ` +
          `answer=${extractText(request.response).length}ch tools=${extractTools(request.response).length}`,
      );
    });
    return lines.join('\n');
  }

  private poll(): void {
    try {
      if (!this.file) {
        const active = this.findActiveFile();
        if (active) {
          this.attach(active);
        }
        return;
      }
      const active = this.findActiveFile();
      if (active && active !== this.file) {
        this.attach(active);
        return;
      }
      if (this.readAppended()) {
        this.lastChange = Date.now();
      }
      this.idleFallback();
      if (Date.now() - this.lastCompact > 15000) {
        this.compactState();
      }
      this.maybeEmitPartial();
    } catch (error) {
      logError('watcher poll failed', error);
    }
  }

  private findActiveFile(): string | undefined {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.chatSessionsDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    let best: { file: string; mtime: number } | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const full = path.join(this.chatSessionsDir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (!best || stat.mtimeMs > best.mtime) {
          best = { file: full, mtime: stat.mtimeMs };
        }
      } catch {
        /* 文件可能刚被删除 */
      }
    }
    return best?.file;
  }

  private attach(file: string): void {
    this.file = file;
    this.sessionId = path.basename(file, '.jsonl');
    this.offset = 0;
    this.leftover = '';
    this.state = undefined;
    this.emitted.clear();
    this.completed.clear();
    this.seenRequests = 0;

    const stat = fs.statSync(file);
    // 大文件只解尾部：全量解析 300MB+ 会阻塞几十秒、峰值内存数 GB
    const TAIL_BYTES = 8 * 1024 * 1024;
    const tail = stat.size > TAIL_BYTES;
    this.lenient = tail;
    if (tail) {
      this.state = {} as SessionState;
    }
    this.readRange(file, tail ? stat.size - TAIL_BYTES : 0, stat.size);
    this.lenient = false;
    this.offset = stat.size;
    this.compactState();
    const state = this.state as SessionState | undefined;
    const requests: any[] = (state?.requests as any[]) ?? [];
    this.seenRequests = requests.length;
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (request && isRequestComplete(request)) {
        this.completed.add(i);
        // 建立基线时已完成的回合不应重放（否则重载窗口会把历史全部发一遍）
        this.emitted.set(i, this.sig(extractText(request.response)));
      }
    }
    this.completedCount = this.completed.size;
    this.baselineIncomplete = requests.length > 0 && !!requests[requests.length - 1] && !isRequestComplete(requests[requests.length - 1]);
    this.lastChange = Date.now();
    log(`watcher: attached ${this.sessionId}, baseline requests=${requests.length}, completed=${this.completedCount}, midTurn=${this.baselineIncomplete}`);
  }

  private readAppended(): boolean {
    if (!this.file) {
      return false;
    }
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size <= this.offset) {
      return false;
    }
    // 每次最多读 4MB，避免落盘批次过大时瞬时内存峰值
    const end = Math.min(size, this.offset + 4 * 1024 * 1024);
    this.readRange(this.file, this.offset, end);
    this.offset = end;
    this.afterIngest();
    return true;
  }

  /** 分块读取并逐行应用补丁，避免把整个 300MB+ 文件读成字符串 */
  private readRange(file: string, start: number, end: number): void {
    const fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(1024 * 1024);
    try {
      let pos = start;
      while (pos < end) {
        const want = Math.min(chunk.length, end - pos);
        const read = fs.readSync(fd, chunk, 0, want, pos);
        if (read <= 0) {
          break;
        }
        pos += read;
        this.ingest(decoder.write(chunk.subarray(0, read)));
      }
      const tail = decoder.end();
      if (tail) {
        this.ingest(tail);
      }
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
      let patch: unknown;
      try {
        patch = JSON.parse(trimmed);
      } catch {
        continue;
      }
      try {
        this.state = this.lenient
          ? (applyPatchLenient(this.state, patch as any) as SessionState)
          : applyPatch(this.state, patch as any);
      } catch {
        // 不重建：重建会读整文件，内存峰值高且会卡住；跳过这一条补丁即可
        if (Date.now() - this.lastPatchErrorLog > 60000) {
          this.lastPatchErrorLog = Date.now();
          log('watcher: 跳过一条无法应用的补丁');
        }
      }
    }
  }

  private rebuild(): void {
    if (!this.file) {
      return;
    }
    const stat = fs.statSync(this.file);
    this.state = undefined;
    this.leftover = '';
    this.readRange(this.file, 0, stat.size);
  }

  /** 只保留同步所需字段（文本/思考/工具名），其余部分置空但保留数组下标 */
  private compactState(): void {
    const state = this.state as SessionState | undefined;
    const requests: any[] = (state?.requests as any[]) ?? [];
    const keepTextFrom = Math.max(0, requests.length - 3);
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (!request || typeof request !== 'object') {
        continue;
      }
      for (const key of [
        'modelState',
        'outputBuffer',
        'promptTokenDetails',
        'contentReferences',
        'codeCitations',
        'variableData',
        'followups',
        'responseMarkdownInfo',
        'modeInfo',
        'modelConfiguration',
        'agent',
      ]) {
        delete request[key];
      }
      const parts: any[] = Array.isArray(request.response) ? request.response : [];
      const keepText = i >= keepTextFrom;
      for (const part of parts) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        if (part.kind === undefined) {
          if (typeof part.value === 'string' && (!keepText || part.value.length > 20000)) {
            part.value = keepText ? part.value.slice(-20000) : '';
          }
          continue;
        }
        if (part.kind === 'thinking') {
          if (typeof part.value === 'string' && !keepText) {
            part.value = '';
          }
          continue;
        }
        if (part.kind === 'toolInvocationSerialized') {
          const message = part.invocationMessage;
          for (const key of Object.keys(part)) {
            if (key !== 'kind' && key !== 'invocationMessage') {
              delete part[key];
            }
          }
          part.invocationMessage = message ?? '';
          continue;
        }
        for (const key of Object.keys(part)) {
          if (key !== 'kind') {
            delete part[key];
          }
        }
      }
    }
    this.lastCompact = Date.now();
  }

  private sig(text: string): string {
    let hash = 0;
    const step = Math.max(1, Math.floor(text.length / 2048));
    for (let i = 0; i < text.length; i += step) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return `${text.length}:${hash}`;
  }

  private afterIngest(): void {
    const requests = this.state?.requests ?? [];
    // 1) 新提问
    for (let i = this.seenRequests; i < requests.length; i++) {
      const request = requests[i];
      if (!request) {
        continue;
      }
      const text = requestText(request);
      if (!request.hiddenFromTranscript && text && !text.startsWith('[Terminal ')) {
        this.onUser?.({
          sessionId: this.sessionId,
          index: i,
          requestId: request.requestId || `${this.sessionId}#${i}`,
          text,
          timestamp: request.timestamp ?? Date.now(),
        });
      }
    }
    if (requests.length > this.seenRequests) {
      this.seenRequests = requests.length;
    }

    // 2) 助手回答（回合结束后落定；结束前的增量在 maybeEmitPartial 中推送）
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (!request) {
        continue;
      }
      if (requestText(request).startsWith('[Terminal ')) {
        this.completed.add(i);
        continue;
      }
      const complete = isRequestComplete(request);
      const newlyComplete = complete && !this.completed.has(i);
      if (newlyComplete) {
        this.completed.add(i);
        this.completedCount += 1;
      }
      const text = extractText(request.response);
      const lastEmitted = this.emitted.get(i);
      if (complete && (newlyComplete || lastEmitted !== this.sig(text))) {
        this.emitted.set(i, this.sig(text));
        if (text) {
          this.assistantCount += 1;
        }
        this.lastPartialAt.delete(i);
        this.lastPartialSig.delete(i);
        this.onAssistant?.({
          sessionId: this.sessionId,
          index: i,
          requestId: request.requestId || `${this.sessionId}#${i}`,
          text,
          tools: extractTools(request.response),
          thinking: extractThinking(request.response),
          complete: true,
          timestamp: request.timestamp,
          aborted: isRequestAborted(request),
        });
      }
    }
    this.maybeEmitPartial();
  }

  /** 回合结束前推送思考 / 已生成内容（节流） */
  private maybeEmitPartial(): void {
    const requests = this.state?.requests ?? [];
    const index = requests.length - 1;
    if (index < 0) {
      return;
    }
    const request = requests[index];
    if (!request || isRequestComplete(request) || requestText(request).startsWith('[Terminal ')) {
      return;
    }    const text = extractText(request.response);
    const thinking = extractThinking(request.response);
    const tools = extractTools(request.response);
    if (!text && !thinking && tools.length === 0) {
      return;
    }
    const signature = `${text.length}|${thinking.length}|${tools.length}|${text.slice(-80)}|${thinking.slice(-80)}`;
    if (this.lastPartialSig.get(index) === signature) {
      return;
    }
    const now = Date.now();
    if (now - (this.lastPartialAt.get(index) ?? 0) < this.partialIntervalMs) {
      return;
    }
    this.lastPartialAt.set(index, now);
    this.lastPartialSig.set(index, signature);
    this.onPartial?.({
      sessionId: this.sessionId,
      index,
      requestId: request.requestId || `${this.sessionId}#${index}`,
      text,
      thinking,
      tools,
      complete: false,
    });
  }

  /** 某些版本可能不写 result 字段：长时间静默后兜底推送一次 */
  private idleFallback(): void {
    if (this.isBusy() === false || !this.state) {
      return;
    }
    const idleFor = Date.now() - this.lastChange;
    if (idleFor < this.idleFallbackMs) {
      return;
    }
    const index = this.state.requests.length - 1;
    const request = this.state.requests[index];
    if (!request || requestText(request).startsWith('[Terminal ')) {
      return;
    }
    if (!request) {
      return;
    }
    const rawText = extractText(request.response);
    const text = rawText;
    if (this.emitted.get(index) === this.sig(text)) {
      return;
    }
    this.emitted.set(index, this.sig(text));
    if (text) {
      this.assistantCount += 1;
    }
    this.onAssistant?.({
      sessionId: this.sessionId,
      index,
      requestId: request.requestId || `${this.sessionId}#${index}`,
      text,
      tools: extractTools(request.response),
      thinking: extractThinking(request.response),
      complete: false,
      timestamp: request.timestamp,
      aborted: false,
    });
    log(`watcher: idle fallback emitted request ${index}`);
  }
}
