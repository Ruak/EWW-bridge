/**
 * 卡片归属判定：决定“收到一条用户提问时，当前这张卡片该复用、收尾还是重置”。
 *
 * 背景：同一条提问会被 transcript（实时源）和 chatSessions（补丁流）各看到一次，
 * 注入的文本还会被回读一次。早先的规则是“卡片上已有内容就换新卡”，
 * 于是同一个问题会并排出现两张「Copilot · 处理中…」。
 * 现在以“提问原文”为第一判定条件：文本相同 = 同一回合，必须复用同一张卡。
 */
export interface TurnSnapshot {
  /** 建卡时记录的本轮提问原文 */
  promptText?: string;
  softFinalText?: string;
  doneAt?: number;
  patches: number;
  lastAnswerText?: string;
  requestIndex?: number;
}

export type UserPromptDecision = 'reuse' | 'release' | 'reset';

/** 归一化：忽略空白差异（不同数据源可能对提问做了 trim/换行处理） */
export const normalizePrompt = (text: string): string => (text || '').replace(/\s+/g, '');

export function decideUserPromptTurn(
  prev: TurnSnapshot | undefined,
  prompt: string,
  index: number | undefined,
): UserPromptDecision {
  if (!prev) {
    return 'reset';
  }
  const samePrompt = !!prev.promptText && normalizePrompt(prev.promptText) === normalizePrompt(prompt);
  if (samePrompt) {
    return 'reuse';
  }
  const hasContent =
    !!prev.softFinalText || !!prev.doneAt || prev.patches > 1 || (prev.lastAnswerText ?? '').length > 0;
  const changedTurn = prev.requestIndex !== undefined && index !== undefined && prev.requestIndex !== index;
  if (hasContent || changedTurn) {
    return 'release';
  }
  return 'reset';
}

/** 卡片状态里与本轮正文相关的字段（resetTurnText 会清空它们） */
export interface TurnTextSnapshot {
  promptText?: string;
  lastAnswerText?: string;
  softFinalText?: string;
  answerFloorLen?: number;
  pendingTextLen?: number;
  lastSentTextLen?: number;
  persistedTextLen?: number;
  doneAt?: number;
  requestIndex?: number;
  lastEventAt?: number;
}

/**
 * 当前状态是否仍属于“这一轮提问”。空 promptText（旧状态/未记录）视为同一轮，保持旧行为。
 */
export function samePromptTurn(state: { promptText?: string } | undefined, prompt: string): boolean {
  if (!state || !state.promptText || !prompt) {
    return true;
  }
  return normalizePrompt(state.promptText) === normalizePrompt(prompt);
}

/**
 * 清掉上一轮残留的快照。
 * transcript 可能还没触发新提问回调（或没来得及换卡）就先送来了新回合的正文，
 * 此时若沿用 lastAnswerText/softFinalText，新卡会顶上一轮的答案（实测事故）。
 */
export function resetTurnText(state: TurnTextSnapshot, prompt: string): void {
  state.promptText = prompt || undefined;
  state.lastAnswerText = undefined;
  state.softFinalText = undefined;
  state.answerFloorLen = 0;
  state.pendingTextLen = 0;
  state.lastSentTextLen = undefined;
  state.persistedTextLen = 0;
  state.doneAt = undefined;
  state.requestIndex = undefined;
  state.lastEventAt = Date.now();
}
