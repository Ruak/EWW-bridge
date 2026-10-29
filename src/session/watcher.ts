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
  /** 是否只解析了文件尾部（大文件）：此时 requests 有空洞、下标不可信 */
  private partialTail = false;
  /** 补丁流里的正文追踪：请求下标 -> 累计正文（仅保留最近几个，限制内存） */
  private tailTexts = new Map<number, { text: string; firstAt: number; lastAt: number; emittedAt: number; emittedText: string }>();
  private tailLastKey?: number;
  /** 激活时的最后一条请求下标；比它更早的历史回合迟到补丁不得重放 */
  private replayFloor = 0;

  /** 流式预览的最小间隔（毫秒），由扩展按设置更新 */
  partialIntervalMs = 800;
  /** 无 result 字段时的空闲兜底阈值（毫秒） */
  idleFallbackMs = 120000;

  onUser?: (event: UserEvent) => void;
  onAssistant?: (event: AssistantEvent) => void;
  /** 回合结束前的增量内容（思考 / 已生成的回答 / 工具） */
  onPartial?: (event: AssistantEvent) => void;
  /** 从补丁流里实时抽到的最新回合正文（不依赖下标，后台等待期也能拿到） */
  onTailText?: (event: { sessionId: string; text: string; firstAt: number }) => void;
  /** 补丁流里出现了某回合的 result（权威完成信号，比 transcript 的 turn_end 更快落盘时用它收尾） */
  onTailComplete?: (event: { sessionId: string; index: number; text: string; firstAt: number }) => void;

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

  /**
   * chatSessions 是否是“只解析了尾部”的残缺状态（文件过大时）。
   * 这种状态下 requests 数组是稀疏的、下标与真实回合号对不上，任何基于下标的出站/重放都不可信，
   * 需要改用 transcript 作为唯一可靠源。
   */
  get partialState(): boolean {
    return this.partialTail;
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
    // 尾部解析会有空洞：必须跳到最后一个真实存在的请求，否则会把“空洞”当成未完成而永远忙
    for (let i = requests.length - 1; i >= 0; i--) {
      const request = requests[i];
      if (request) {
        return !isRequestComplete(request);
      }
    }
    return false;
  }

  /** 最近一个非系统请求的状态：只有 result 才算完成，elapsedMs=0 且无 result 才算中断 */
  latestStatus(): 'pending' | 'completed' | 'aborted' | 'unknown' {
    const requests = this.state?.requests ?? [];
    for (let i = requests.length - 1; i >= 0; i--) {
      const request = requests[i];
      if (!request) {
        continue;
      }
      if (requestText(request).startsWith('[Terminal ')) {
        continue;
      }
      if (isRequestAborted(request)) {
        return 'aborted';
      }
      if (isRequestComplete(request)) {
        return 'completed';
      }
      return 'pending';
    }
    return 'unknown';
  }

  /**
   * 指定回合的正文；不传 index 时只看最新的非系统请求（不再回退到更早的回合，避免新回合串上旧正文）
   */
  latestAnswerText(index?: number): string {
    const requests = this.state?.requests ?? [];
    if (typeof index === 'number') {
      const request = requests[index];
      if (!request || requestText(request).startsWith('[Terminal ')) {
        return '';
      }
      return extractText(request.response);
    }
    for (let i = requests.length - 1; i >= 0; i--) {
      const request = requests[i];
      if (!request) {
        continue;
      }
      if (requestText(request).startsWith('[Terminal ')) {
        continue;
      }
      return extractText(request.response);
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

  /** 手动跟随最新会话（新开了对话但没自动切过去时用） */
  forceFollowLatest(): string | undefined {
    const active = this.findActiveFile();
    if (active && active !== this.file) {
      log(`watcher: 手动切换会话 -> ${path.basename(active, '.jsonl').slice(0, 8)}`);
      this.attach(active);
      return this.sessionId;
    }
    return this.sessionId;
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
        // 只有当前会话已经彻底停了（2 分钟内无写入）才切换到新文件，
        // 否则其它聊天标签页/后台会话一被触碰就会把镜像“抢走”，表现得像乱入消息
        let currentFresh = false;
        let createdNewer = false;
        try {
          const cur = fs.statSync(this.file);
          const next = fs.statSync(active);
          currentFresh = Date.now() - cur.mtimeMs < 120000;
          // 新建会话的判定：候选文件的创建时间晚于当前文件的最后一次写入
          createdNewer = next.birthtimeMs > cur.mtimeMs + 1000;
        } catch {
          currentFresh = false;
        }
        let activeFresh = false;
        try {
          activeFresh = Date.now() - fs.statSync(active).mtimeMs < 120000;
        } catch {
          activeFresh = false;
        }
        // “开了新对话”这个场景要立即切：新文件是刚创建的，且当前会话没有在跑的回合
        if ((createdNewer && !this.isBusy()) || (!currentFresh && activeFresh)) {
          log(`watcher: 切换会话 ${path.basename(this.file, '.jsonl').slice(0, 8)} -> ${path.basename(active, '.jsonl').slice(0, 8)}`);
          this.attach(active);
          return;
        }
      }
      if (this.readAppended()) {
        this.lastChange = Date.now();
      }
      this.idleFallback();
      this.flushTailText();
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
    this.tailTexts.clear();
    this.tailLastKey = undefined;

    const stat = fs.statSync(file);
    // 大文件只解尾部：全量解析 300MB+ 会阻塞几十秒、峰值内存数 GB
    const TAIL_BYTES = 8 * 1024 * 1024;
    const tail = stat.size > TAIL_BYTES;
    this.lenient = tail;
    this.partialTail = tail;
    if (tail) {
      this.state = {} as SessionState;
    }
    this.readRange(file, tail ? stat.size - TAIL_BYTES : 0, stat.size);
    // 残缺尾部下后续补丁也可能引用“我们没解析到的旧路径”，必须继续宽松应用，否则新回合直接丢失
    this.lenient = tail;
    this.offset = stat.size;
    this.compactState();
    const state = this.state as SessionState | undefined;
    const requests: any[] = (state?.requests as any[]) ?? [];
    this.seenRequests = requests.length;
    // 尾部解析时历史回合的补丁可能迟到落盘（例如数小时前的请求才补上 result）：
    // 只允许“最后一条（可能仍在跑）”及其之后的新请求触发终稿
    this.replayFloor = Math.max(0, requests.length - 1);
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (request && isRequestComplete(request)) {
        this.completed.add(i);
        // 建立基线时已完成的回合不应重放（否则重载窗口会把历史全部发一遍）
        this.emitted.set(i, this.sig(extractText(request.response)));
      }
    }
    this.completedCount = this.completed.size;
    const lastIndex = this.lastRequestIndex();
    const lastRequest = lastIndex >= 0 ? requests[lastIndex] : undefined;
    this.baselineIncomplete = !!lastRequest && !isRequestComplete(lastRequest);
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
        this.trackText(patch);
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

  /** 最后一个真实存在的请求下标（尾部解析会有空洞，不能用 requests.length - 1） */
  private lastRequestIndex(): number {
    const requests = this.state?.requests ?? [];
    for (let i = requests.length - 1; i >= 0; i--) {
      if (requests[i]) {
        return i;
      }
    }
    return -1;
  }

  /** 从补丁流里实时抽到的最新回合正文（不依赖下标）；firstAt 可用于判断是否属于当前回合 */
  tailText(): { index: number; text: string; firstAt: number; lastAt: number } | undefined {
    if (this.tailLastKey === undefined) {
      return undefined;
    }
    const entry = this.tailTexts.get(this.tailLastKey);
    if (!entry) {
      return undefined;
    }
    return { index: this.tailLastKey, text: entry.text, firstAt: entry.firstAt, lastAt: entry.lastAt };
  }

  /**
   * 补丁流正文追踪：chatSessions 比 transcript 更早落盘（实测后台等待期 +12s vs 等唤醒），
   * 但大文件只能尾部解析、下标不可信，所以这里完全按“补丁路径 + 追加顺序”重建最新回合的正文。
   */
  private trackText(patch: any): void {
    const path = patch?.k;
    if (!Array.isArray(path) || path[0] !== 'requests') {
      return;
    }
    const index = typeof path[1] === 'number' ? path[1] : undefined;
    if (index === undefined) {
      return;
    }
    if (path[2] === 'result') {
      const done = this.tailTexts.get(index);
      this.onTailComplete?.({
        sessionId: this.sessionId,
        index,
        text: done?.text ?? '',
        firstAt: done?.firstAt ?? Date.now(),
      });
      return;
    }
    if (path[2] !== 'response') {
      return;
    }
    const now = Date.now();
    let entry = this.tailTexts.get(index);
    if (!entry) {
      entry = { text: '', firstAt: now, lastAt: 0, emittedAt: 0, emittedText: '' };
      this.tailTexts.set(index, entry);
      // 只保留最近 3 个请求，避免长会话累积
      if (this.tailTexts.size > 3) {
        const oldest = Array.from(this.tailTexts.entries())
          .sort((a, b) => a[1].firstAt - b[1].firstAt)
          .slice(0, this.tailTexts.size - 3);
        for (const [key] of oldest) {
          this.tailTexts.delete(key);
        }
      }
    }
    const parts = Array.isArray(patch.v) ? patch.v : [patch.v];
    if (patch.kind === 1) {
      // 整体赋值：重建该回合正文
      entry.text = parts.map((part: any) => this.partText(part)).join('');
    } else {
      const appended = parts.map((part: any) => this.partText(part)).join('');
      if (appended) {
        entry.text = entry.text.length > 40000 ? entry.text.slice(-40000) : entry.text;
        entry.text += appended;
      }
    }
    entry.lastAt = now;
    this.tailLastKey = index;
    this.flushTailText(entry);
  }

  /** 节流上报：正文有增长且距上次上报 >= 800ms；未到时间就留给下一次 poll 补发，避免最后一段丢失 */
  private flushTailText(entry?: { text: string; emittedAt: number; emittedText: string; firstAt: number }): void {
    const target = entry ?? (this.tailLastKey !== undefined ? this.tailTexts.get(this.tailLastKey) : undefined);
    if (!target || !target.text || target.text === target.emittedText) {
      return;
    }
    const now = Date.now();
    if (now - target.emittedAt < 800) {
      return;
    }
    target.emittedAt = now;
    target.emittedText = target.text;
    this.onTailText?.({ sessionId: this.sessionId, text: target.text, firstAt: target.firstAt });
  }

  private partText(part: any): string {
    if (!part || typeof part !== 'object') {
      return '';
    }
    if (part.kind !== undefined) {
      return '';
    }
    return typeof part.value === 'string' ? part.value : '';
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
      if (i < this.replayFloor) {
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
    const index = this.lastRequestIndex();
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
    const index = this.lastRequestIndex();
    if (index < 0) {
      return;
    }
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
