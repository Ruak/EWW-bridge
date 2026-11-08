/* 卡片归属判定单测：node test/card-owner.js
 * 复现场景：同一条提问被 transcript 与 chatSessions 各看到一次（注入文本还会被回读），
 * 旧规则「有内容就换卡」会并排出现两张「Copilot · 处理中…」。
 */
const { decideUserPromptTurn } = require('../out/cardLifecycle.js');

const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};
const expect = (label, actual, want) => {
  if (actual !== want) {
    fail(`${label}: 期望 ${want}，实际 ${actual}`);
  }
};

// 1) 注入后 transcript 建了占位卡（无正文）→ chatSessions 迟到看到同一条提问：必须复用
expect(
  '占位卡 + 同一提问',
  decideUserPromptTurn({ promptText: '#ai 查一下作业', patches: 1 }, '#ai 查一下作业', 0),
  'reuse',
);

// 2) 已经流式输出多帧（patches>1）后再看到同一提问：仍然复用，不能换卡
expect(
  '已推多帧 + 同一提问',
  decideUserPromptTurn(
    { promptText: '#ai 查一下作业', patches: 5, lastAnswerText: '正在查看…' },
    '#ai   查一下作业\n',
    0,
  ),
  'reuse',
);

// 3) 同一提问但下标不同（两个数据源索引错位）：仍复用，只更新下标
expect(
  '同一提问 + 下标错位',
  decideUserPromptTurn({ promptText: '你好', patches: 3, requestIndex: 7 }, '你好', 0),
  'reuse',
);

// 4) 真正的新提问，且上一张卡已有内容：收尾旧卡、换新卡
expect(
  '新提问 + 旧卡有内容',
  decideUserPromptTurn(
    { promptText: '#ai 第一个任务', patches: 4, lastAnswerText: '完了' },
    '#ai 第二个任务',
    1,
  ),
  'release',
);

// 5) 上一张卡已定稿（软结束）：新提问同样要换卡
expect(
  '新提问 + 旧卡已定稿',
  decideUserPromptTurn({ promptText: '旧问题', patches: 2, softFinalText: '答案' }, '新问题', 2),
  'release',
);

// 6) 占位卡（尚无内容）遇到不同提问：直接重置沿用，不新开卡
expect(
  '空占位卡 + 新提问',
  decideUserPromptTurn({ promptText: '旧问题', patches: 1 }, '新问题', 1),
  'reset',
);

// 7) 没有状态：reset（交由调用方建卡）
expect('无状态', decideUserPromptTurn(undefined, '任意', 0), 'reset');

// 8) 没有记录 promptText 的旧状态：按内容判定（有内容则 release）
expect(
  '旧状态无 promptText + 有内容',
  decideUserPromptTurn({ patches: 3, lastAnswerText: 'x' }, '任意', 0),
  'release',
);

// ---- 新回合不能携带上一轮正文 ----
const { samePromptTurn, resetTurnText } = require('../out/cardLifecycle.js');
const pickLonger = (a, b) => ((a || '').length >= (b || '').length ? a : b);

const prevTurn = {
  promptText: '旧问题：帮我统计昨天的日志',
  lastAnswerText: '这是上一轮的完整回答，长度明显更长，绝不能出现在新卡片里。'.repeat(3),
  softFinalText: '上一轮软结束文本',
  answerFloorLen: 120,
  pendingTextLen: 120,
  lastSentTextLen: 120,
  persistedTextLen: 120,
  doneAt: Date.now(),
  requestIndex: 7,
  patches: 5,
};
const newPrompt = '新问题：把这份报告导出成 PDF';
if (samePromptTurn(prevTurn, newPrompt)) {
  fail('不同提问不应被判为同一轮');
}
if (!samePromptTurn(prevTurn, '旧问题：帮我统计昨天的日志  ')) {
  fail('仅空白差异的同一提问应判为同一轮');
}
if (!samePromptTurn(prevTurn, '') || !samePromptTurn({}, newPrompt)) {
  fail('没有提问文本时不应重置（保持旧行为）');
}

resetTurnText(prevTurn, newPrompt);
for (const key of ['lastAnswerText', 'softFinalText', 'doneAt', 'requestIndex']) {
  if (prevTurn[key] !== undefined) {
    fail(`resetTurnText 未清空 ${key}`);
  }
}
if (prevTurn.promptText !== newPrompt) {
  fail('resetTurnText 未更新 promptText');
}
const newText = '新回合的短回答。';
if (pickLonger(newText, prevTurn.lastAnswerText ?? '') !== newText) {
  fail('清空后新回合正文不应被上一轮文本覆盖');
}

console.log('PASS: 同一提问复用同一张卡（占位/多帧/下标错位），新提问才换卡；新回合不携带上一轮正文');
