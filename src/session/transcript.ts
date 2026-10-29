import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from '../log';

export interface StreamDelta {
  sessionId: string;
  thinking: string;
  text: string;
  tools: string[];
}

/** 正在执行的工具（用于卡片显示“正在执行 xxx（已 Ns）”） */
export interface ToolActivity {
  name: string;
  detail: string;
  startedAt: number;
}

/** 数据源：普通 transcript 目录，或 Copilot agent 会话目录（~/.copilot/session-state/<id>/events.jsonl） */
export interface TranscriptSource {
  dir: string;
  layout: 'flat' | 'session-state';
  /** session-state 模式下的项目目录（用 workspace.yaml 的 cwd 过滤，避免跨项目串台） */
  workspaceFolder?: string;
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
 * 另外还支持第二个源：~/.copilot/session-state/<id>/events.jsonl（agent 会话，事件格式完全一致且实时落盘）。
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
  /** 没有 turn_end 时的静默兜底阈值（VS Code 偶尔漏写 turn_end）；必须足够长，否则思考期就会误收尾 */
  stallIdleMs = 120000;

  private turnEndedAt = 0;
  private softFinalSent = false;
  private settledAt = 0;
  /** 已看到 turn_start/user.message，但还没等到 turn_end */
  private turnOpen = false;
  /** 本任务（一次提问）的开始时间与耗时（turn_end 时结算） */
  private turnStartedAt = 0;
  private lastElapsedMs = 0;
  /** 静默摄入（重载回看）：只重建状态，不触发任何回调 */
  private silent = false;
  private toolInFlightCount = 0;
  private toolStarts = new Map<string, ToolActivity>();
  private lastLoggedTextLen = 0;

  onDelta?: (event: StreamDelta) => void;
  onSoftFinal?: (event: StreamDelta) => void;
  onUserPrompt?: (event: { sessionId: string; text: string }) => void;
  onSessionChange?: (sessionId: string) => void;
  /** 正在执行的工具变化（开始 / 结束），用于即时刷新卡片进展 */
  onTool?: (activity: ToolActivity | undefined) => void;
  /** 回合进行中收到了新的 user.message（后台终端通知 / steering / 手动新消息） */
  onInterrupt?: (content: string) => void;

  constructor(
    private readonly sourceInput: string | TranscriptSource[],
    private readonly pollMs = 200,
  ) {
    this.sources =
      typeof sourceInput === 'string' ? [{ dir: sourceInput, layout: 'flat' }] : sourceInput;
  }

  private readonly sources: TranscriptSource[];

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

  /** 当前是否在跟随 agent 会话（~/.copilot/session-state），此时 chatSessions 属于别的聊天，不能混用 */
  get isAgentSession(): boolean {
    return !!this.file && this.file.replace(/\\/g, '/').includes('/.copilot/session-state/');
  }

  /** 本轮是否已真正落定（turn_end 后静默超过阈值），仅作辅助信号 */
  get settled(): boolean {
    return this.settledAt > 0;
  }

  /** 落定的时间戳（毫秒）；0 表示未落定 */
  get settledAtMs(): number {
    return this.settledAt;
  }

  /** 正在执行的工具（按开始时间升序） */
  activeTools(): ToolActivity[] {
    return Array.from(this.toolStarts.values()).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 正在执行的工具数（tool.execution_start/complete 配对） */
  get toolInFlight(): number {
    return this.toolInFlightCount;
  }

  /**
   * 回合是否仍在运行：模型步未 turn_end（含长思考）或有在途工具（含长终端命令）。
   * 注入前必须用它判定，绝不能在为 true 时提交，否则会打断 VS Code 正在输出的消息。
   * 注意：VS Code 偶尔不写 turn_end（已在实测中遇到），静默 2 分钟后不再当作运行中，否则队列永远卡住。
   */
  isTurnRunning(): boolean {
    if (this.toolInFlightCount > 0) {
      return true;
    }
    return this.turnOpen && this.quietMs < 120000;
  }

  /** 卡片收尾用：无在途工具且静默够久（不依赖 turn_end，VS Code 有时确实不写） */
  get cardSettled(): boolean {
    return this.toolInFlightCount === 0 && this.quietMs > this.stallIdleMs;
  }

  /** 距离最近一条 transcript 事件的静默毫秒数 */
  get quietMs(): number {
    return this.lastEventAt ? Date.now() - this.lastEventAt : Number.MAX_SAFE_INTEGER;
  }

  /** 本任务耗时（毫秒，turn_end 时结算） */
  get elapsedMs(): number {
    if (this.lastElapsedMs) {
      return this.lastElapsedMs;
    }
    return this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
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
    this.toolStarts.clear();
    this.turnOpen = false;
    this.turnStartedAt = 0;
    this.lastElapsedMs = 0;
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
      this.pruneStaleTools();
      this.flush();
      this.maybeSoftFinal();
    } catch (error) {
      logError('transcript poll failed', error);
    }
  }

  private findNewest(): string | undefined {
    let best: { file: string; mtime: number } | undefined;
    for (const source of this.sources) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(source.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (source.layout === 'flat') {
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const full = path.join(source.dir, entry.name);
          try {
            const stat = fs.statSync(full);
            if (!best || stat.mtimeMs > best.mtime) best = { file: full, mtime: stat.mtimeMs };
          } catch {
            /* 文件可能刚被替换 */
          }
        }
        continue;
      }
      // session-state：<dir>/<sessionId>/events.jsonl，用 workspace.yaml 的 cwd 过滤本项目
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(source.dir, entry.name);
        const events = path.join(sessionDir, 'events.jsonl');
        if (!fs.existsSync(events)) continue;
        if (source.workspaceFolder && !this.sessionMatchesFolder(sessionDir, source.workspaceFolder)) {
          continue;
        }
        try {
          const stat = fs.statSync(events);
          if (!best || stat.mtimeMs > best.mtime) best = { file: events, mtime: stat.mtimeMs };
        } catch {
          /* 忽略 */
        }
      }
    }
    return best?.file;
  }

  /** 用 workspace.yaml 的 cwd / git_root 判断该 agent 会话是否属于当前项目 */
  private sessionMatchesFolder(sessionDir: string, folder: string): boolean {
    try {
      const text = fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8');
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const target = norm(folder);
      for (const line of text.split('\n')) {
        const m = /^(cwd|git_root):\s*(.+)$/.exec(line.trim());
        if (m && norm(m[2].trim()) === target) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private attach(file: string): void {
    this.file = file;
    this.sessionId = path.basename(file, '.jsonl');
    this.leftover = '';
    this.reset();
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    // 从最后一个真实提问开始回看（重载时保证本轮已有正文不丢），最多回看 4MB
    let start = size;
    const REWIND = 4 * 1024 * 1024;
    if (size > 0 && size <= REWIND) {
      start = 0;
    } else if (size > REWIND) {
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(REWIND);
        fs.readSync(fd, buf, 0, REWIND, size - REWIND);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n');
        let offset = size - REWIND;
        let found = -1;
        for (const line of lines) {
          if (line.includes('"user.message"')) {
            try {
              const ev = JSON.parse(line);
              if (
                ev?.type === 'user.message' &&
                typeof ev.data?.content === 'string' &&
                !ev.data.content.startsWith('[Terminal ')
              ) {
                found = offset;
              }
            } catch {
              /* 半截行，忽略 */
            }
          }
          offset += Buffer.byteLength(line, 'utf8') + 1;
        }
        if (found >= 0) {
          start = found;
        }
      } catch {
        /* 回看失败就用文件末尾 */
      }
    }
    this.offset = start;
    this.silent = true;
    try {
      this.readAppended();
    } catch {
      /* 静默摄入失败不影响后续增量 */
    }
    this.silent = false;
    log(`transcript: attached ${this.sessionId} (${start === size ? 'from end' : `rewind ${size - start}B`})`);
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
        this.turnOpen = true;
        this.lastEventAt = Date.now();
        return;
      }
      if (this.active) {
        if (!this.silent) {
          this.onInterrupt?.(content);
        }
      }
      if (content) {
        this.userPrompts += 1;
        if (!this.silent) {
          this.onUserPrompt?.({ sessionId: this.sessionId, text: content });
        }
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
      this.toolStarts.clear();
      this.lastLoggedTextLen = 0;
      this.turnOpen = true;
      this.turnStartedAt = Date.now();
      this.lastElapsedMs = 0;
      this.lastEventAt = Date.now();
      return;
    }
    if (type === 'assistant.turn_start') {
      this.active = true;
      this.turnOpen = true;
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
          // agent 会话的最终答复不在 content，而在 task_complete 工具参数的 summary 里
          if (request.name === 'task_complete') {
            const summary =
              request.arguments && typeof request.arguments.summary === 'string'
                ? request.arguments.summary
                : '';
            this.appendFinalAnswer(summary);
            continue;
          }
          this.pushTool(request.name);
        }
      }
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'session.task_complete') {
      // 同一段收尾文案的另一个来源（事件流最后一条），去重后追加
      // 不能清 turnEndedAt：这条事件常常紧跟在 turn_end 之后，清零会把收尾推迟到 120s 兜底
      this.appendFinalAnswer(typeof data.summary === 'string' ? data.summary : '');
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'tool.execution_start') {
      if (typeof data.toolName === 'string') {
        this.pushTool(data.toolName);
      }
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : `t${this.toolInFlightCount}`;
      const activity: ToolActivity = {
        name: typeof data.toolName === 'string' ? data.toolName : 'tool',
        detail: this.toolDetail(data.arguments),
        startedAt: Date.now(),
      };
      this.toolStarts.set(callId, activity);
      this.toolInFlightCount += 1;
      if (!this.silent) {
        this.onTool?.(activity);
      }
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'tool.execution_complete') {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      if (callId) {
        this.toolStarts.delete(callId);
      } else if (this.toolStarts.size > 0) {
        const oldest = this.activeTools()[0];
        for (const [key, value] of this.toolStarts) {
          if (value === oldest) {
            this.toolStarts.delete(key);
            break;
          }
        }
      }
      this.toolInFlightCount = Math.max(0, this.toolInFlightCount - 1);
      if (!this.silent) {
        this.onTool?.(this.activeTools().slice(-1)[0]);
      }
      this.turnEndedAt = 0;
      this.softFinalSent = false;
      this.settledAt = 0;
    } else if (type === 'assistant.turn_end') {
      // 每条模型消息结束都会触发；若后续没有工具/新消息，则视为回合结束
      this.turnEndedAt = Date.now();
      this.turnOpen = false;
      if (this.turnStartedAt) {
        this.lastElapsedMs = Date.now() - this.turnStartedAt;
      }
    } else {
      return;
    }
    this.lastEventAt = Date.now();
    this.dirty = true;
  }

  private maybeSoftFinal(): void {
    if (this.softFinalSent) {
      return;
    }
    // 有 turn_end 时按 800ms 静默；没有 turn_end（VS Code 漏写）时用 5s 静默兜底
    if (this.turnEndedAt) {
      if (Date.now() - this.turnEndedAt < this.softFinalIdleMs) {
        return;
      }
    } else if (this.toolInFlightCount > 0 || this.quietMs < this.stallIdleMs) {
      return;
    }
    // 没有  turn_end 且一句话正文都没有：不要发软结束（否则卡片会显示“本轮没有文字输出”）
    if (!this.turnEndedAt && !this.text.trim()) {
      return;
    }
    this.settledAt = Date.now();
    this.softFinalSent = true;
    this.active = false;
    this.turnOpen = false;
    if (this.silent || !this.thinking && !this.text && this.tools.length === 0) {
      return;
    }
    this.onSoftFinal?.({
      sessionId: this.sessionId,
      thinking: this.thinking,
      text: this.text,
      tools: [...this.tools],
    });
  }

  /** 工具 start 后没等到 complete（回合被取消/中断）会永久占住“在途”，超过 5 分钟就丢弃 */
  private pruneStaleTools(): void {
    if (this.toolStarts.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [id, tool] of this.toolStarts) {
      if (now - tool.startedAt > 300000) {
        this.toolStarts.delete(id);
        this.toolInFlightCount = Math.max(0, this.toolInFlightCount - 1);
        log(`transcript: 丢弃超时未完成的工具记录 ${tool.name}`);
      }
    }
  }

  private appendThinking(chunk: string): void {
    this.thinking = capTail(`${this.thinking}${this.thinking ? '\n\n' : ''}${chunk}`, 20000);
  }

  private appendText(chunk: string): void {
    this.text = capTail(`${this.text}${this.text ? '\n\n' : ''}${chunk}`, 20000);
  }

  /**
   * agent（新式会话）的最终答复：assistant.message.content 为空，正文放在
   * `task_complete` 工具参数的 summary（以及最后的 `session.task_complete` 事件）里。
   * 两个来源都要收，且去重。
   */
  private appendFinalAnswer(summary: string): void {
    const text = (summary || '').trim();
    if (!text) {
      return;
    }
    if (this.text.trim().endsWith(text)) {
      return;
    }
    this.appendText(text);
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

  /** 从工具参数里抽一行可读摘要（终端命令 / 搜索词 / 文件路径） */
  private toolDetail(args: unknown): string {
    if (!args || typeof args !== 'object') {
      return '';
    }
    const obj = args as Record<string, unknown>;
    for (const key of ['command', 'commandLine', 'query', 'filePath', 'path', 'url']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        const line = value.trim().split('\n')[0].trim();
        return line.length > 90 ? `${line.slice(0, 90)}…` : line;
      }
    }
    return '';
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
    if (this.silent) {
      return;
    }
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
