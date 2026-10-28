/* 卡片渲染单测：node test/card.js */
const assert = require('assert');
const { buildCardV1, buildCardV2, buildStreamingCards, normalizeMarkdownForFeishu, renderStreamingMarkdown, splitMarkdown, stripCodeBlocks, tail } = require('../out/feishu/card.js');

// 1) 卡片结构
const card = JSON.parse(buildCardV2('hello', { title: 't', template: 'blue' }));
assert.strictEqual(card.schema, '2.0');
assert.strictEqual(card.body.elements[0].tag, 'markdown');
const legacy = JSON.parse(buildCardV1('hello', { title: 't' }));
assert.ok(Array.isArray(legacy.elements));

// 2) 长文分段
const long = 'a'.repeat(20000);
const chunks = splitMarkdown(long, 7000);
assert.ok(chunks.length >= 3);
for (const chunk of chunks) {
  assert.ok(chunk.length <= 7000, `分片超长: ${chunk.length}`);
}

// 3) 思考/回答预览
const md = renderStreamingMarkdown({
  thinking: '第一步\n第二步',
  answer: '正在生成...',
  tools: ['运行 npm test'],
  status: '⏳ 正在输出…',
});
assert.ok(md.includes('思考过程'));
assert.ok(md.includes('> 第一步'));
assert.ok(md.includes('工具调用'));
assert.ok(md.includes('正在输出'));

// 4) 空内容只显示状态
const empty = renderStreamingMarkdown({ status: '已收到' });
assert.strictEqual(empty, '_已收到_');

// 5) 尾部截断
const truncated = tail('x'.repeat(100) + 'TAIL', 10);
assert.ok(truncated.endsWith('TAIL'));
assert.ok(truncated.includes('前文已省略'));

// 6) 折叠面板：流式展开、完成折叠
const live = buildStreamingCards({
  title: '🤖 Copilot · 思考中…',
  thinking: '第一步\n第二步',
  answer: '正在生成',
  expanded: true,
  showThinking: true,
});
const liveCard = JSON.parse(live.v2);
assert.strictEqual(liveCard.schema, '2.0');
const livePanel = liveCard.body.elements.find((el) => el.tag === 'collapsible_panel');
assert.ok(livePanel, '流式卡片应包含折叠面板');
assert.strictEqual(livePanel.expanded, true, '流式时应展开');
assert.strictEqual(livePanel.header.icon_position, 'right');
assert.strictEqual(livePanel.elements[0].tag, 'markdown');
assert.ok(livePanel.elements[0].content.includes('第一步'));
assert.ok(live.v1.includes('>'));

const done = buildStreamingCards({
  title: '🤖 Copilot',
  thinking: '第一步',
  answer: '最终答案',
  expanded: false,
  showThinking: true,
});
const donePanel = JSON.parse(done.v2).body.elements.find((el) => el.tag === 'collapsible_panel');
assert.strictEqual(donePanel.expanded, false, '完成后应折叠');

// 关思考时不应出现面板
const noThinking = JSON.parse(
  buildStreamingCards({ title: 'x', answer: 'y', expanded: false, showThinking: false }).v2,
);
assert.ok(!noThinking.body.elements.some((el) => el.tag === 'collapsible_panel'));

// 7) 代码块应被剔除，避免飞书渲染成空行
assert.strictEqual(stripCodeBlocks('前\n```ts\nconst x = 1\n```\n后'), '前\n〔代码已省略〕\n后');
const withCode = buildStreamingCards({
  title: 't',
  thinking: '思考\n```\nsecret\n```',
  answer: '正文\n```js\nlet a = 1\n```',
  expanded: false,
});
if (withCode.v2.includes('let a = 1') || withCode.v2.includes('secret')) {
  throw new Error('代码内容未被剔除');
}
if (!withCode.v2.includes('已省略')) {
  throw new Error('代码占位文案缺失');
}

// 8) 与 VS Code 一致的 Markdown 归一化
assert.strictEqual(normalizeMarkdownForFeishu('# 标题'), '**标题**');
assert.strictEqual(normalizeMarkdownForFeishu('- [x] 完成\n- [ ] 未完成'), '- [x] 完成\n- [ ] 未完成');
assert.strictEqual(normalizeMarkdownForFeishu('---'), '────────');
assert.strictEqual(
  normalizeMarkdownForFeishu('```ts\nconst a = 1;\nconsole.log(a);\n```'),
  '〔ts 代码 2 行已省略〕',
);
assert.strictEqual(
  normalizeMarkdownForFeishu('| A | B |\n|---|---|\n| 1 | 2 |'),
  '**A · B**\n- 1 · 2',
);
// 未闭合围栏（流式中途）也要吃掉，避免飞书留白
assert.strictEqual(normalizeMarkdownForFeishu('开头\n```ts\nconst a = 1;'), '开头\n〔ts 代码 1 行，输出中已省略〕');
// 编辑工作产生的空围栏（VS Code 编辑卡片占位）直接丢弃
assert.strictEqual(normalizeMarkdownForFeishu('前文\n\n```\n\n\n\n```\n\n后文'), '前文\n\n后文');
assert.strictEqual(normalizeMarkdownForFeishu('```\n\n\n\n```'), '');
assert.strictEqual(normalizeMarkdownForFeishu('```\n\n\n\n```\n\n```\n\n\n\n```\n\n真正内容'), '真正内容');
// 奇数个孤立标记 + 后面是正文：只丢标记，不能把正文当代码省略
assert.strictEqual(
  normalizeMarkdownForFeishu('```\n\n已装 **0.20.2**，需要重载。'),
  '已装 **0.20.2**，需要重载。',
);
// 无语言但有内容的代码块仍保留占位
assert.strictEqual(normalizeMarkdownForFeishu('```\n15:07:07 outbound: stream card\n15:07:25 outbound: stream patch=2\n```'), '〔代码 2 行已省略〕');
// VS Code 会写奇数个空围栏标记：不能把后面的整段正文当成代码吞掉
assert.strictEqual(
  normalizeMarkdownForFeishu('```\n\n```\n\n```\n\n\n## 标题\n\n正文 **粗**\n\n| A | B |\n|---|---|\n| 1 | 2 |'),
  '**标题**\n正文 **粗**\n\n**A · B**\n- 1 · 2',
);
// 行内代码去壳、file 链接保留文字
assert.strictEqual(normalizeMarkdownForFeishu('见 `src/a.ts`'), '见 src/a.ts');
assert.strictEqual(
  normalizeMarkdownForFeishu('[card.ts](file:///d:/repo/src/card.ts)'),
  'card.ts',
);
assert.strictEqual(
  normalizeMarkdownForFeishu('[x](https://a.com/b)'),
  '[x](https://a.com/b)',
);
// emoji 剔除
assert.strictEqual(normalizeMarkdownForFeishu('好 ✅ 的'), '好 的');
assert.strictEqual(normalizeMarkdownForFeishu('好 ✅ 的', { keepEmoji: true }), '好 ✅ 的');

// 超长内容自动缩容，保证 UTF-8 字节数不超飞书上限
const huge = buildStreamingCards({
  title: '压测',
  thinking: '思考'.repeat(8000),
  answer: '正文'.repeat(8000),
  expanded: false,
  thinkingLimit: 6000,
  answerLimit: 12000,
});
assert.ok(Buffer.byteLength(huge.v2, 'utf8') <= 24000, `卡片过大: ${Buffer.byteLength(huge.v2, 'utf8')}`);
assert.ok(huge.v2.includes('正文'), '缩容后仍然保留正文');

console.log('PASS: 卡片渲染、分段、折叠面板、代码块剔除与 Markdown 归一化符合预期');
