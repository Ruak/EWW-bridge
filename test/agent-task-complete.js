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
  // summary 是最终答复：必须**替换**过程中的旁白，而不是拼接（否则卡片像混进非正文内容）
  if (last.text.includes('先看容器状态。')) {
    throw new Error(`过程旁白没有被替换：${JSON.stringify(last.text)}`);
  }
  if (last.text.trim() !== summary.trim()) {
    throw new Error(`最终正文应等于 summary，实际：${JSON.stringify(last.text)}`);
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
  if (after.text.trim() !== before) {
    throw new Error('重复 summary 事件导致正文变化');
  }
  // 每来一条新的 user.message，回合序号必须递增（卡片用它判断“这一帧是不是上一轮的”）
  const seqBefore = watcher.turnIndex;
  append({ type: 'user.message', data: { content: '再跑一次同样的检查' } });
  await delay(200);
  if (watcher.turnIndex !== seqBefore + 1) {
    throw new Error(`回合序号未递增：${seqBefore} -> ${watcher.turnIndex}`);
  }
  watcher.stop();
  console.log('PASS: agent 最终答复用 task_complete summary 替换过程旁白且不重复');
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
