/* 会话选择（listSessions / pin / unpin）单测：node test/session-picker.js */
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

const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-picker-'));
  const flatDir = path.join(root, 'transcripts');
  const agentRoot = path.join(root, 'session-state');
  fs.mkdirSync(flatDir, { recursive: true });
  const project = path.join(root, 'proj');

  const writeSession = (file, content, mtimeOffsetSeconds) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    const when = new Date(Date.now() + mtimeOffsetSeconds * 1000);
    fs.utimesSync(file, when, when);
  };

  // 经典会话：旧的 + 新的
  writeSession(
    path.join(flatDir, 'classic-old.jsonl'),
    JSON.stringify({ type: 'user.message', data: { content: '旧问题' } }) + '\n',
    -1800,
  );
  writeSession(
    path.join(flatDir, 'classic-new.jsonl'),
    JSON.stringify({ type: 'user.message', data: { content: '新问题' } }) + '\n',
    -1200,
  );

  // agent 会话：带标题与项目目录
  const agentOne = path.join(agentRoot, 'agent-1111');
  writeSession(
    path.join(agentOne, 'events.jsonl'),
    JSON.stringify({ type: 'user.message', data: { content: 'agent 旧' } }) + '\n',
    -900,
  );
  fs.writeFileSync(
    path.join(agentOne, 'workspace.yaml'),
    `id: agent-1111\ncwd: ${project}\nname: 读 handoff 文档并继续\n`,
    'utf8',
  );
  const agentTwo = path.join(agentRoot, 'agent-2222');
  writeSession(
    path.join(agentTwo, 'events.jsonl'),
    JSON.stringify({ type: 'user.message', data: { content: 'agent 新' } }) + '\n',
    0,
  );
  fs.writeFileSync(
    path.join(agentTwo, 'workspace.yaml'),
    `id: agent-2222\ncwd: ${project}\nname: 修复同步问题\n`,
    'utf8',
  );

  const watcher = new TranscriptWatcher(
    [
      { dir: flatDir, layout: 'flat' },
      { dir: agentRoot, layout: 'session-state', workspaceFolder: project },
    ],
    60,
  );
  watcher.partialIntervalMs = 40;
  watcher.start();
  await delay(200);

  // 1) 列表：按时间倒序，agent 会话带标题
  const list = watcher.listSessions(10);
  if (list.length !== 4) {
    fail(`应有 4 个候选会话，实际 ${list.length}`);
  }
  if (list[0].layout !== 'session-state' || list[0].title !== '修复同步问题') {
    fail(`最新的应是“修复同步问题”，实际 ${JSON.stringify(list[0])}`);
  }
  if (!list.some((item) => item.layout === 'flat' && item.id === 'classic-old.jsonl'.replace('.jsonl', ''))) {
    fail('列表缺少经典会话');
  }
  if (!list.some((item) => item.workspace === project)) {
    fail('agent 会话应带上所属项目目录');
  }

  // 2) 默认跟随最新（agent-2222）
  if (watcher.currentSessionId !== 'agent-2222') {
    fail(`默认应跟随最新 agent 会话，实际 ${watcher.currentSessionId}`);
  }

  // 3) 固定到较旧的经典会话
  const target = list.find((item) => item.layout === 'flat' && item.id === 'classic-old');
  watcher.pinSession(target.file, target.layout);
  await delay(200);
  if (watcher.currentSessionId !== 'classic-old') {
    fail(`固定后应跟随 classic-old，实际 ${watcher.currentSessionId}`);
  }
  if (watcher.isAgentSession) {
    fail('固定经典会话后不应仍标记为 agent 会话');
  }
  // 让“最新”文件继续更新，固定状态不能被抢走
  writeSession(path.join(agentTwo, 'events.jsonl'), JSON.stringify({ type: 'user.message', data: { content: 'x' } }) + '\n', 0);
  await delay(250);
  if (watcher.currentSessionId !== 'classic-old') {
    fail(`有新写入时固定的会话不应被切换，实际 ${watcher.currentSessionId}`);
  }

  // 4) 取消固定 → 回到最新
  watcher.unpinSession();
  await delay(250);
  if (watcher.currentSessionId !== 'agent-2222') {
    fail(`取消固定后应回到最新，实际 ${watcher.currentSessionId}`);
  }

  // 5) 固定的文件被删 → 自动恢复跟随
  watcher.pinSession(path.join(flatDir, 'classic-old.jsonl'), 'flat');
  fs.rmSync(path.join(flatDir, 'classic-old.jsonl'));
  await delay(250);
  if (watcher.pinnedFile) {
    fail('固定文件删除后应清空 pin');
  }
  if (watcher.currentSessionId !== 'agent-2222') {
    fail(`固定文件删除后应跟随最新，实际 ${watcher.currentSessionId}`);
  }

  watcher.stop();
  console.log('PASS: 会话选择（列表/固定/取消固定/固定文件丢失自动恢复）');
})().catch((error) => {
  console.error('FAIL:', error && error.message ? error.message : error);
  process.exit(1);
});
