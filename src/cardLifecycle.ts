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
