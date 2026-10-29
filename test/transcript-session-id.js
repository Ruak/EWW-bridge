/* session-state（agent 会话）的会话 id 单测：node test/transcript-session-id.js */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-agent-'));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  const sessionId = '54f51ce9-2fb1-45c5-8740-8efb0e0fb269';
  const sessionDir = path.join(stateDir, sessionId);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `id: ${sessionId}\ncwd: ${project}\nbranch: main\n`);
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  // 事件文件统一叫 events.jsonl：会话 id 只能来自父目录
  fs.writeFileSync(eventsFile, JSON.stringify({ type: 'session.start', data: {} }) + '\n');

  const watcher = new TranscriptWatcher([{ dir: stateDir, layout: 'session-state', workspaceFolder: project }], 60);
  watcher.partialIntervalMs = 50;
  watcher.stallIdleMs = 600000;
  const sessions = [];
  const prompts = [];
  const deltas = [];
  watcher.onSessionChange = (id) => sessions.push(id);
  watcher.onUserPrompt = (event) => prompts.push(event.sessionId);
  watcher.onDelta = (event) => deltas.push(event.sessionId);
  watcher.start();
  await delay(250);

  if (sessions.length !== 1) {
    throw new Error(`期望 1 次会话附加，实际 ${sessions.length}`);
  }
  if (sessions[0] === 'events') {
    throw new Error('session-state 的会话 id 不能取文件名 events（必须取父目录名）');
  }
  if (sessions[0] !== sessionId) {
    throw new Error(`会话 id 错误: ${sessions[0]}，期望 ${sessionId}`);
  }
  if (!watcher.isAgentSession) {
    throw new Error('session-state 源必须判定为 agent 会话（chatSessions 不能混用）');
  }

  const append = (obj) => fs.appendFileSync(eventsFile, JSON.stringify(obj) + '\n');
  append({ type: 'user.message', data: { content: '远端提问' } });
  append({ type: 'assistant.message', data: { content: '回答正文', reasoningText: '' } });
  await delay(300);

  if (prompts.length === 0 || prompts[0] !== sessionId) {
    throw new Error(`提问事件未带上正确的会话 id: ${JSON.stringify(prompts)}`);
  }
  if (deltas.length === 0 || deltas[deltas.length - 1] !== sessionId) {
    throw new Error(`增量事件未带上正确的会话 id: ${JSON.stringify(deltas)}`);
  }

  watcher.stop();
  console.log(JSON.stringify({ sessionId: sessions[0], prompts: prompts.length, deltas: deltas.length }, null, 2));
  console.log('PASS: agent 会话的会话 id 取自父目录，与事件回调一致');
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
