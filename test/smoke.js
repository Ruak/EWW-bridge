/* 冒烟测试：模拟 chatSessions 补丁流，验证用户/助手事件提取。
 * 运行：node test/smoke.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 在扩展宿主之外运行：给 vscode 模块一个最小替身
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    const channel = { appendLine() {}, show() {}, dispose() {} };
    return {
      window: { createOutputChannel: () => channel },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      ThemeColor: class {},
    };
  }
  return originalLoad.apply(this, arguments);
};

const { SessionWatcher } = require('../out/session/watcher.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-bridge-'));
  const file = path.join(dir, 'test-session.jsonl');
  const snapshot = {
    kind: 0,
    v: {
      version: 3,
      sessionId: 'test-session',
      requests: [
        {
          requestId: 'req-0',
          timestamp: Date.now() - 60000,
          message: { text: '历史问题' },
          response: [{ value: '历史回答' }],
          result: { timings: {} },
        },
      ],
      pendingRequests: [],
      inputState: { inputText: '' },
    },
  };
  fs.writeFileSync(file, JSON.stringify(snapshot) + '\n');

  const watcher = new SessionWatcher(dir, 100);
  watcher.partialIntervalMs = 80;
  const users = [];
  const assistants = [];
  const partials = [];
  watcher.onUser = (event) => users.push(event);
  watcher.onAssistant = (event) => assistants.push(event);
  watcher.onPartial = (event) => partials.push(event);
  watcher.start();

  await delay(300); // 建立基线

  const append = (obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

  // 1) 用户提问
  append({ kind: 2, k: ['requests'], v: [{ requestId: 'req-1', timestamp: Date.now(), message: { text: '你好，介绍一下项目' }, response: [] }] });
  await delay(300);

  // 2) 流式回答（两段 markdown）+ 工具调用
  append({
    kind: 2,
    k: ['requests', 1, 'response'],
    v: [
      { kind: 'thinking', value: '内部思考不应推送到飞书' },
      { kind: 'toolInvocationSerialized', invocationMessage: { value: '正在读取 README.md' } },
      { value: '第一段回答。' },
    ],
  });
  await delay(200);
  append({ kind: 2, k: ['requests', 1, 'response'], v: [{ value: '第二段回答。' }] });
  await delay(400);
  if (assistants.length !== 0) {
    throw new Error('回答未结束时不应推送最终消息');
  }
  if (partials.length === 0) {
    throw new Error('回合结束前应推送流式预览');
  }
  if (!partials[0].thinking.includes('内部思考')) {
    throw new Error('流式预览未包含思考过程');
  }
  if (!partials[partials.length - 1].text.includes('第二段回答')) {
    throw new Error('流式预览未包含已生成的回答');
  }
  const partialCountBeforeComplete = partials.length;

  // 3) 回合结束
  append({ kind: 1, k: ['requests', 1, 'result'], v: { timings: { totalElapsed: 1000 } } });
  await delay(300);
  if (partials.length !== partialCountBeforeComplete) {
    throw new Error('回合结束后不应再推送流式预览');
  }

  // 4) 第二个提问（验证多轮）
  append({ kind: 2, k: ['requests'], v: [{ requestId: 'req-2', timestamp: Date.now(), message: { text: '再来一轮' }, response: [] }] });
  await delay(200);
  append({ kind: 2, k: ['requests', 2, 'response'], v: [{ value: '第二轮回答。' }] });
  append({ kind: 1, k: ['requests', 2, 'result'], v: { timings: {} } });
  await delay(300);

  append({ kind: 2, k: ['requests'], v: [{ requestId: 'req-3', timestamp: Date.now(), message: { text: '中断测试' }, response: [] }] });
  await delay(200);
  append({ kind: 2, k: ['requests', 3, 'response'], v: [{ value: '部分输出' }] });
  append({ kind: 1, k: ['requests', 3, 'elapsedMs'], v: 0 });
  await delay(300);

  watcher.stop();

  const report = { users: users.map((u) => u.text), assistants: assistants.map((a) => ({ text: a.text, tools: a.tools })), partials: partials.length };
  console.log(JSON.stringify(report, null, 2));

  const fail = (message) => {
    console.error('FAIL:', message);
    process.exit(1);
  };
  if (users.length !== 3) fail(`期望 3 条用户消息，实际 ${users.length}`);
  if (users[0].text !== '你好，介绍一下项目') fail('用户消息内容错误');
  if (users[2].text !== '中断测试') fail('中断回合的用户消息错误');
  if (assistants.length !== 3) fail(`期望 3 条回答，实际 ${assistants.length}`);
  if (assistants.some((item) => item.text.includes('历史回答'))) fail('历史回合被重放');
  if (partials.some((item) => item.text.includes('历史回答'))) fail('历史回合产生了流式预览');
  if (assistants[0].text !== '第一段回答。\n\n第二段回答。') fail(`回答合并错误: ${JSON.stringify(assistants[0].text)}`);
  if (assistants[0].tools.length !== 1) fail('工具调用摘要提取失败');
  if (assistants[0].thinking !== '内部思考不应推送到飞书') fail('思考内容提取错误');
  if (assistants[1].text !== '第二轮回答。') fail('第二轮回答错误');
  if (assistants[2].aborted !== true) fail('中断回合未被标记为 aborted');

  console.log('\nPASS: 会话解析与事件提取符合预期');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
