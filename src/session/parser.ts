export interface ResponsePart {
  kind?: string;
  value?: unknown;
  invocationMessage?: unknown;
  [key: string]: unknown;
}

export interface RequestRecord {
  requestId?: string;
  timestamp?: number;
  responseTimestamp?: number;
  message?: { text?: string; parts?: unknown[] };
  response?: ResponsePart[];
  modelId?: string;
  modeInfo?: { kind?: string };
  result?: unknown;
  elapsedMs?: number;
  isComplete?: boolean;
  completionTokens?: number;
  hiddenFromTranscript?: boolean;
  [key: string]: unknown;
}

export interface SessionState {
  sessionId?: string;
  requests: RequestRecord[];
  pendingRequests?: unknown[];
  [key: string]: unknown;
}

export interface PatchLine {
  kind: number;
  v: unknown;
  k?: (string | number)[];
}

/**
 * chatSessions/<id>.jsonl 的补丁语义（实测）：
 *   kind 0 = 全量快照
 *   kind 1 = 对指定路径赋值
 *   kind 2 = 向指定数组追加元素（v 为数组）
 */
/**
 * 尾部解析用的宽松版：路径缺失时自动建对象/数组。
 * 只能拿到最近若干请求（旧请求会被留成空洞），但内存和耗时都是常数级。
 */
export function applyPatchLenient(state: any, patch: PatchLine): any {
  if (patch.kind === 0) {
    return patch.v;
  }
  const path = patch.k;
  if (!Array.isArray(path) || path.length === 0) {
    return state;
  }
  const root = state && typeof state === 'object' ? state : {};
  let cursor: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as any;
    const next = path[i + 1];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') {
      cursor[key] = typeof next === 'number' ? [] : {};
    }
    cursor = cursor[key];
  }
  const last = path[path.length - 1] as any;
  if (patch.kind === 1) {
    cursor[last] = patch.v;
    return root;
  }
  if (patch.kind === 2) {
    const rawIndex = (patch as any).i;
    const hasValue = (patch as any).v !== undefined;
    const incoming = hasValue ? (Array.isArray((patch as any).v) ? (patch as any).v : [(patch as any).v]) : undefined;
    let target = cursor[last];
    if (!Array.isArray(target)) {
      target = [];
      cursor[last] = target;
    }
    if (!incoming) {
      if (typeof rawIndex === 'number') {
        target.splice(rawIndex, 1);
      }
      return root;
    }
    if (typeof rawIndex === 'number' && rawIndex <= target.length) {
      target.splice(rawIndex, 0, ...incoming);
    } else {
      target.push(...incoming);
    }
    return root;
  }
  cursor[last] = patch.v;
  return root;
}

export function applyPatch(state: SessionState | undefined, patch: PatchLine): SessionState {
  if (patch.kind === 0) {
    return patch.v as SessionState;
  }
  if (!state || !patch.k || patch.k.length === 0) {
    throw new Error('invalid patch');
  }
  const path = patch.k;
  let cursor: any = state;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]];
    if (cursor === undefined || cursor === null) {
      throw new Error(`invalid patch path: ${path.join('/')}`);
    }
  }
  const last = path[path.length - 1];
  if (patch.kind === 1) {
    cursor[last] = patch.v;
    return state;
  }
  if (patch.kind === 2) {
    const rawIndex = (patch as any).i;
    const index = typeof rawIndex === 'number' ? rawIndex : undefined;
    const hasValue = (patch as any).v !== undefined;
    const incoming = hasValue ? (Array.isArray(patch.v) ? (patch.v as any[]) : [patch.v]) : undefined;
    const target = Array.isArray(cursor) && typeof last === 'number' ? cursor[last] : (cursor as any)[last];
    if (Array.isArray(target)) {
      if (!incoming) {
        // 实测：{kind:2, k:['pendingRequests'], i:1} 表示删除下标 i 的元素
        if (index !== undefined) {
          target.splice(index, 1);
        }
        return state;
      }
      if (index !== undefined && index < target.length) {
        target.splice(index, 0, ...incoming);
      } else {
        target.push(...incoming);
      }
      return state;
    }
    if (incoming) {
      (cursor as any)[last] = incoming;
    }
    return state;
  }
  // 未知补丁类型：按赋值处理，保持向前兼容
  cursor[last] = patch.v;
  return state;
}

export function isTextPart(part: ResponsePart): part is ResponsePart & { value: string } {
  return part.kind === undefined && typeof part.value === 'string';
}

export function isThinkingPart(part: ResponsePart): part is ResponsePart & { value: string } {
  return part.kind === 'thinking' && typeof part.value === 'string';
}

export function isToolPart(part: ResponsePart): boolean {
  return part.kind === 'toolInvocationSerialized';
}

export function toolLabel(part: ResponsePart): string {
  const message = part.invocationMessage as any;
  if (typeof message === 'string') {
    return message;
  }
  if (message && typeof message.value === 'string') {
    return message.value;
  }
  return '';
}

/** 去掉 VS Code 偶发的"整段响应重复写入两遍"（实测 req 的文本分片会出现完全相同的两半） */
function dedupeHalves(chunks: string[]): string[] {
  const n = chunks.length;
  if (n >= 2 && n % 2 === 0) {
    const half = n / 2;
    let same = true;
    for (let i = 0; i < half; i++) {
      if (chunks[i] !== chunks[half + i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return chunks.slice(0, half);
    }
  }
  return chunks;
}

export function extractText(parts: ResponsePart[] | undefined): string {
  const chunks = (parts || []).filter(isTextPart).map((p) => p.value as string);
  return dedupeHalves(chunks).join('\n\n').trim();
}

export function extractTools(parts: ResponsePart[] | undefined): string[] {
  const labels: string[] = [];
  for (const part of parts || []) {
    if (!isToolPart(part)) {
      continue;
    }
    const label = toolLabel(part).trim().replace(/\s+/g, ' ');
    if (label && labels[labels.length - 1] !== label) {
      labels.push(label);
    }
  }
  return labels;
}

export function extractThinking(parts: ResponsePart[] | undefined): string {
  return (parts || []).filter(isThinkingPart).map((p) => p.value as string).join('\n\n').trim();
}

export function isRequestComplete(request: RequestRecord): boolean {
  return request.result !== undefined || typeof request.elapsedMs === 'number' || request.isComplete === true;
}

/** VS Code 侧被取消/中断：有耗时字段但为 0，且没有 result */
export function isRequestAborted(request: RequestRecord): boolean {
  return request.result === undefined && request.elapsedMs === 0;
}

export function requestText(request: RequestRecord): string {
  return ((request.message && request.message.text) || '').trim();
}
