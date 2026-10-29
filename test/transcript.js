/* transcript 实时源单测：node test/transcript.js */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-transcript-'));
  const file = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session.start', data: {} }) + '\n');

  const watcher = new TranscriptWatcher(dir, 80);
  watcher.partialIntervalMs = 50;
  watcher.softFinalIdleMs = 120;
  watcher.stallIdleMs = 600000;
  const deltas = [];
  const sessions = [];
  const softFinals = [];
  const prompts = [];
  const interrupts = [];
  watcher.onDelta = (event) => deltas.push(event);
  watcher.onSessionChange = (id) => sessions.push(id);
  watcher.onSoftFinal = (event) => softFinals.push(event);
  watcher.onUserPrompt = (event) => prompts.push(event.text);
  watcher.onInterrupt = (content) => interrupts.push(content);
  watcher.start();
  await delay(250);

  if (sessions.length !== 1) {
    throw new Error(`期望 1 次会话附加，实际 ${sessions.length}`);
  }

  const append = (obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

  // 1) 思考 + 正文 + 工具请求
  append({
    type: 'assistant.message',
    data: {
      content: '开始分析问题。',
      reasoningText: '第一步：读取配置。',
      toolRequests: [{ name: 'read_file' }],
    },
  });
  await delay(300);

  if (deltas.length === 0) {
    throw new Error('未产生实时增量');
  }
  const first = deltas[deltas.length - 1];
  if (!first.thinking.includes('第一步')) {
    throw new Error('思考内容未提取');
  }
  if (!first.text.includes('开始分析')) {
    throw new Error('正文未提取');
  }
  if (first.tools[0] !== 'read_file') {
    throw new Error(`工具未提取: ${JSON.stringify(first.tools)}`);
  }

  // 2) 工具执行事件
  append({ type: 'tool.execution_start', data: { toolName: 'run_in_terminal' } });
  await delay(250);
  const second = deltas[deltas.length - 1];
  if (!second.tools.includes('run_in_terminal')) {
    throw new Error('工具执行事件未累计');
  }
  if (!watcher.isTurnRunning()) {
    throw new Error('有在途工具时必须判定为回合运行中（注入不能提交）');
  }
  if (!second.text.includes('开始分析')) {
    throw new Error('累计正文丢失');
  }
  if (watcher.toolInFlight !== 1) {
    throw new Error(`工具在途计数错误: ${watcher.toolInFlight}`);
  }
  append({ type: 'tool.execution_complete', data: { toolName: 'run_in_terminal' } });
  await delay(200);
  if (watcher.toolInFlight !== 0) {
    throw new Error(`工具完成后计数未清零: ${watcher.toolInFlight}`);
  }

  // 2.5) turn_end 后静默 → 软结束（不再等 chatSessions）
  append({ type: 'assistant.turn_end', data: {} });
  await delay(350);
  if (softFinals.length !== 1) {
    throw new Error(`期望 1 次软结束，实际 ${softFinals.length}`);
  }
  if (!softFinals[0].text.includes('开始分析')) {
    throw new Error('软结束未携带累计内容');
  }
  if (watcher.isTurnRunning()) {
    throw new Error('turn_end 且无在途工具时应判定为回合已结束');
  }

  // 2.6) 用户消息事件（transcript 也会记录）
  append({ type: 'user.message', data: { content: '远端提问' } });
  await delay(250);
  if (prompts.length === 0 || prompts[0] !== '远端提问') {
    throw new Error(`用户消息未提取: ${JSON.stringify(prompts)}`);
  }

  // 3) 回合结束清空
  watcher.reset();
  append({ type: 'assistant.message', data: { content: '第二轮回答', reasoningText: '第二轮思考' } });
  await delay(300);
  const third = deltas[deltas.length - 1];
  if (third.text !== '第二轮回答' || third.thinking !== '第二轮思考') {
    throw new Error(`reset 后未重新累计: ${JSON.stringify(third)}`);
  }

  // 4) 回合进行中收到后台终端通知 → 属于同一回合的 steering 消息，不算打断
  append({ type: 'assistant.turn_start', data: {} });
  await delay(100);
  append({
    type: 'user.message',
    data: { content: '[Terminal abc notification: command completed with exit code 0. The terminal has been cleaned up.]' },
  });
  await delay(250);
  if (interrupts.length !== 0) {
    throw new Error(`终端通知不应打断回合: ${JSON.stringify(interrupts)}`);
  }

  // 4.5) 真正的用户新消息仍然算打断
  append({ type: 'user.message', data: { content: '手动插入的新问题' } });
  await delay(250);
  if (interrupts.length !== 1 || interrupts[0] !== '手动插入的新问题') {
    throw new Error(`用户新消息未判定为打断: ${JSON.stringify(interrupts)}`);
  }

  // 5) 新回合不得携带上一轮内容
  append({ type: 'assistant.turn_start', data: {} });
  await delay(80);
  append({ type: 'assistant.message', data: { content: '上一轮回答', reasoningText: '上一轮思考' } });
  await delay(150);
  append({ type: 'user.message', data: { content: '新问题' } });
  await delay(120);
  append({ type: 'assistant.message', data: { content: '新回答', reasoningText: '新思考' } });
  await delay(250);
  const latest = deltas[deltas.length - 1];
  if (latest.text !== '新回答' || latest.thinking !== '新思考') {
    throw new Error(`新回合携带了旧内容: ${JSON.stringify(latest)}`);
  }

  // 6) VS Code 漏写 turn_end：只发 turn_start + assistant.message，静默后也必须收尾
  watcher.stallIdleMs = 200;
  const softBefore = softFinals.length;
  append({ type: 'user.message', data: { content: '漏掉 turn_end 的提问' } });
  await delay(60);
  append({ type: 'assistant.turn_start', data: {} });
  append({ type: 'assistant.message', data: { content: '这段回答不会收到 turn_end' } });
  await delay(500);
  if (softFinals.length <= softBefore) {
    throw new Error('没有 turn_end 时也必须在静默后触发收尾（否则卡片会永远停在处理中）');
  }
  if (!softFinals[softFinals.length - 1].text.includes('不会收到 turn_end')) {
    throw new Error('收尾未携带正文');
  }
  if (!watcher.cardSettled) {
    throw new Error('静默且无在途工具时应判定可以收尾');
  }

  // 7) 每一步模型消息都有自己的 turn_start/turn_end：下一步已经开始时不能软收尾，
  //    否则卡片会在“处理中/已完成”之间反复（实测：步骤间隔常有 3s+）
  watcher.stallIdleMs = 600000;
  watcher.softFinalIdleMs = 120;
  const beforeSoft = softFinals.length;
  append({ type: 'user.message', data: { content: '多步提问' } });
  append({ type: 'assistant.turn_start', data: {} });
  append({ type: 'assistant.message', data: { content: '第一步正文' } });
  await delay(60);
  append({ type: 'assistant.turn_end', data: {} });
  append({ type: 'assistant.turn_start', data: {} });
  await delay(400);
  if (softFinals.length !== beforeSoft) {
    throw new Error('新的一步已经开始时不应软收尾（否则卡片会在处理中/已完成之间反复）');
  }
  if (!watcher.isTurnRunning()) {
    throw new Error('两步之间必须仍然判定为回合运行中');
  }
  append({ type: 'assistant.message', data: { content: '第二步正文' } });
  append({ type: 'assistant.turn_end', data: {} });
  await delay(400);
  if (softFinals.length !== beforeSoft + 1) {
    throw new Error(`真正的回合结束必须软收尾，实际软收尾 ${softFinals.length - beforeSoft} 次`);
  }
  if (!softFinals[softFinals.length - 1].text.includes('第二步正文')) {
    throw new Error('收尾未携带最后一步的正文');
  }
  if (watcher.isTurnRunning()) {
    throw new Error('整轮结束后必须判定为不在运行');
  }

  // 8) 用户在 VS Code 侧发了消息马上停止：一句话正文都没有，也必须软收尾并标记 aborted，
  //    否则飞书卡片会永远停在“处理中”（agent 会话的 abort 事件）
  const beforeAbort = softFinals.length;
  append({ type: 'user.message', data: { content: '发了马上停止' } });
  append({ type: 'assistant.turn_start', data: {} });
  append({ type: 'abort', data: { reason: 'user_initiated' } });
  append({ type: 'assistant.turn_end', data: {} });
  await delay(400);
  if (softFinals.length !== beforeAbort + 1) {
    throw new Error(`停止后必须软收尾（否则卡片永远停在处理中），实际 ${softFinals.length - beforeAbort} 次`);
  }
  const abortFinal = softFinals[softFinals.length - 1];
  if (abortFinal.aborted !== true) {
    throw new Error('停止产生的软收尾必须标记 aborted');
  }
  if (abortFinal.text.trim()) {
    throw new Error(`停止的回合不应带正文: ${abortFinal.text}`);
  }
  if (watcher.isTurnRunning()) {
    throw new Error('停止后必须判定为不在运行');
  }

  watcher.stop();
  console.log(JSON.stringify({ deltas: deltas.length, sessions, softFinals: softFinals.length, prompts: prompts.length }, null, 2));
  console.log('PASS: transcript 增量提取符合预期');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
