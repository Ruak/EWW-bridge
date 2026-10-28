/* 回归测试：重载后历史回合的迟到终稿不得重放，且正文查询必须限定到指定回合。
 * 运行：node test/replay-floor.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

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
const assert = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-bridge-replay-'));
  const file = path.join(dir, 'replay-session.jsonl');
  const now = Date.now();
  const snapshot = {
    kind: 0,
    v: {
      version: 3,
      sessionId: 'replay-session',
      requests: [
        {
          requestId: 'req-0',
          timestamp: now - 3 * 3600 * 1000,
          message: { text: '三小时前的问题' },
          response: [{ value: '三小时前的回答' }],
        },
        {
          requestId: 'req-1',
          timestamp: now - 60000,
          message: { text: '当前问题' },
          response: [{ value: '正在生成' }],
        },
      ],
      pendingRequests: [],
      inputState: { inputText: '' },
    },
  };
  fs.writeFileSync(file, JSON.stringify(snapshot) + '\n');

  const watcher = new SessionWatcher(dir, 100);
  watcher.partialIntervalMs = 80;
  const assistants = [];
  watcher.onAssistant = (event) => assistants.push(event);
  watcher.start();
  await delay(300);

  const append = (obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

  // 1) 三小时前的回合补上了 result（重载后历史补丁迟到落盘）：不得当成新终稿
  append({ kind: 1, k: ['requests', 0, 'result'], v: { timings: { totalElapsedMs: 1000 } } });
  await delay(300);
  assert(
    assistants.every((event) => event.index !== 0),
    `历史回合 #0 不应重放，实际收到: ${JSON.stringify(assistants.map((e) => e.index))}`,
  );

  // 2) 当前回合结束：必须正常推送
  append({ kind: 1, k: ['requests', 1, 'result'], v: { timings: { totalElapsedMs: 2000 } } });
  await delay(400);
  assert(
    assistants.some((event) => event.index === 1),
    '当前回合 #1 的终稿必须推送',
  );

  // 3) 正文查询必须限定回合：不得把旧回合的回答当成当前回合
  assert(watcher.latestAnswerText(0) === '三小时前的回答', 'latestAnswerText(0) 应取第 0 回合正文');
  assert(watcher.latestAnswerText(1) === '正在生成', 'latestAnswerText(1) 应取第 1 回合正文');
  assert(watcher.latestAnswerText(9) === '', '未知回合不得回退到其它回合的正文');

  watcher.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: 历史回合不重放 + 正文查询限定回合');
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
