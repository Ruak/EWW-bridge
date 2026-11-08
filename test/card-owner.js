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

console.log('PASS: 同一提问复用同一张卡（占位/多帧/下标错位），新提问才换卡');
