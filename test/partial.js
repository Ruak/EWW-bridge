/* 残缺尾部（大文件只解析尾部）回归测试：node test/partial.js
 * 验证两件事：
 *   1) 文件超过 8MB 时 watcher 标记 partialState（出站改由 transcript 驱动）
 *   2) requests 数组有空洞时 isBusy 不能把空洞当成“未完成”而永远忙
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    const channel = { appendLine() {}, show() {}, dispose() {} };
    return {
      window: { createOutputChannel: () => channel },
      workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
      ThemeColor: class {},
    };
  }
  return originalLoad.apply(this, arguments);
};

const { SessionWatcher } = require('../out/session/watcher.js');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-partial-'));
  const file = path.join(dir, 'big-session.jsonl');
  const now = Date.now();
  const snapshot = {
    kind: 0,
    v: { version: 3, sessionId: 'big-session', requests: [], pendingRequests: [], inputState: { inputText: '' } },
  };
  fs.writeFileSync(file, JSON.stringify(snapshot) + '\n');

  const append = (obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  // 用大量小补丁把文件撑到 8MB 以上（模拟长会话），保证尾部是一批完整行
  const pad = 'y'.repeat(900);
  for (let i = 0; i < 9500; i++) {
    append({ kind: 1, k: ['pad', i], v: pad });
  }

  const watcher = new SessionWatcher(dir, 100);
  watcher.partialIntervalMs = 80;
  watcher.onAssistant = () => undefined;
  watcher.start();
  await delay(300);

  assert(watcher.partialState === true, '大文件必须标记 partialState（下标不可信）');
  assert(fs.statSync(file).size > 8 * 1024 * 1024, '测试文件必须超过 8MB');

  // 稀疏下标：模拟尾部解析产生的空洞（真实回合号远大于数组里存在的条目）
  append({ kind: 1, k: ['requests', 100, 'message'], v: { text: '稀疏请求' } });
  append({ kind: 1, k: ['requests', 100, 'timestamp'], v: now });
  append({ kind: 1, k: ['requests', 100, 'response'], v: [{ value: '稀疏回答' }] });
  await delay(400);
  assert(watcher.isBusy() === true, '最后一个真实请求未完成时应判忙碌');

  append({ kind: 1, k: ['requests', 100, 'result'], v: { timings: { totalElapsedMs: 1 } } });
  await delay(400);
  assert(watcher.isBusy() === false, '空洞不能让 isBusy 永远为真');

  // 3) 补丁流正文追踪：无需完整状态也能拿到最新回合正文（后台等待期靠它提前同步）
  let tailEvent;
  watcher.onTailText = (event) => {
    tailEvent = event;
  };
  append({ kind: 2, k: ['requests'], v: [{ requestId: 'r-new', message: { text: '新问题' } }] });
  append({ kind: 2, k: ['requests', 200, 'response'], v: [{ value: '第一段正文。' }] });
  await delay(300);
  append({
    kind: 2,
    k: ['requests', 200, 'response'],
    v: [{ value: '第二段正文。' }, { kind: 'thinking', value: '思考不应计入正文' }],
  });
  await delay(1400);
  const tail = watcher.tailText();
  assert(!!tail, '补丁流里应能提取到正文');
  assert(
    tail.text === '第一段正文。第二段正文。',
    `补丁流正文提取错误（思考混入或遗漏）: ${JSON.stringify(tail.text)}`,
  );
  assert(!!tailEvent && tailEvent.text.includes('第二段正文'), 'onTailText 应上报增量后的正文');

  watcher.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: 残缺尾部标记 + 空洞不影响忙碌判定');
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
