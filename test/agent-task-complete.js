/* agent（新式会话）task_complete 最终答复单测：node test/agent-task-complete.js */
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
    };
  }
  return originalLoad.apply(this, arguments);
};

const { TranscriptWatcher } = require('../out/session/transcript.js');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-agent-'));
  const file = path.join(dir, 'sess-agent.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session.start', data: {} }) + '\n');

  const watcher = new TranscriptWatcher(dir, 60);
  watcher.partialIntervalMs = 40;
  watcher.softFinalIdleMs = 100;
  watcher.stallIdleMs = 600000;
  const softFinals = [];
  const deltas = [];
  watcher.onSoftFinal = (event) => softFinals.push(event);
  watcher.onDelta = (event) => deltas.push(event);
  watcher.start();
  await delay(200);

  const append = (obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

  append({ type: 'user.message', data: { content: '检查部署状态' } });
  await delay(150);
  append({ type: 'assistant.turn_start', data: {} });
  append({ type: 'assistant.message', data: { content: '先看容器状态。', toolRequests: [] } });
  await delay(150);

  // agent 的最终答复：content 为空，正文在 task_complete 的 summary
  const summary = '### 结论\n全部容器运行正常，无 traceback。';
  append({
    type: 'assistant.message',
    data: { content: '', toolRequests: [{ name: 'task_complete', arguments: { summary, success: true } }] },
  });
  append({ type: 'assistant.turn_end', data: {} });
  await delay(400);

  const last = softFinals[softFinals.length - 1];
  if (!last) {
    throw new Error('未收到软结束');
  }
  if (!last.text.includes('全部容器运行正常')) {
    throw new Error(`最终答复缺失 task_complete summary：${JSON.stringify(last.text)}`);
  }
  if (!last.text.startsWith('先看容器状态。')) {
    throw new Error(`过程正文丢失：${JSON.stringify(last.text)}`);
  }
  if (last.tools.includes('task_complete')) {
    throw new Error('task_complete 不应作为工具展示');
  }
  // 末尾重复的 session.task_complete 不应重复追加同一段
  const before = last.text.trim();
  append({ type: 'session.task_complete', data: { summary, success: true } });
  await delay(400);
  const after = softFinals[softFinals.length - 1];
  if (after.text.split('全部容器运行正常').length - 1 !== 1) {
    throw new Error(`汇总文案被重复追加：${JSON.stringify(after.text.slice(-120))}`);
  }
  if (after.text.trim().length < before.length) {
    throw new Error('最终答复变短');
  }
  watcher.stop();
  console.log('PASS: agent task_complete 最终答复纳入同步且不重复');
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
