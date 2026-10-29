/* 兼容性自检单测：node test/compat.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCompatReport, probeEventTypes } = require('../out/compat.js');

const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-compat-'));
const chatSessionsDir = path.join(root, 'chatSessions');
const transcriptsDir = path.join(root, 'GitHub.copilot-chat', 'transcripts');
const agentRoot = path.join(root, 'session-state');
const agentDir = path.join(agentRoot, 'abc123');
for (const dir of [chatSessionsDir, transcriptsDir, agentDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
const write = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const knownEvents = [
  { type: 'session.start', data: {} },
  { type: 'user.message', data: { content: 'hi' } },
  { type: 'assistant.message', data: { content: 'hello', toolRequests: [] } },
  { type: 'assistant.turn_end', data: {} },
];

write(path.join(chatSessionsDir, 's1.jsonl'), [{ kind: 0, v: {} }]);
write(path.join(transcriptsDir, 't1.jsonl'), knownEvents);
write(path.join(agentDir, 'events.jsonl'), knownEvents);
fs.writeFileSync(path.join(agentDir, 'workspace.yaml'), 'id: abc123\ncwd: d:/Desktop/repo/EWW\ngit_root: d:/Desktop/repo/EWW\n');

const base = {
  vscodeVersion: '1.143.1',
  extensionVersion: '1.1.1',
  copilotVersion: '0.71.0',
  patchState: 'patched',
  patchFile: path.join(root, 'extension.js'),
  chatSessionsDir,
  transcriptDir: transcriptsDir,
  agentRoot,
  workspaceFolder: 'D:\\Desktop\\repo\\EWW',
  sessionId: 'abc12345-0000-0000-0000-000000000000',
  isAgentSession: true,
  quietMs: 3000,
};

const report = buildCompatReport(base);
if (!report.ok) {
  fail(`健康环境应通过，实际问题：${report.problems.join('；')}`);
}
for (const keyword of ['chatSessions', 'transcript', 'agent 会话', '当前跟随', '结论']) {
  if (!report.lines.some((line) => line.includes(keyword))) {
    fail(`报告缺少「${keyword}」一行：\n${report.lines.join('\n')}`);
  }
}
if (!report.lines.some((line) => line.includes('已知事件 4/4'))) {
  fail(`应统计出 4/4 已知事件：\n${report.lines.join('\n')}`);
}

// 1) 补丁锚点不匹配 → 必须报出来
const unsupported = buildCompatReport({ ...base, patchState: 'unsupported' });
if (unsupported.ok || !unsupported.problems.some((p) => p.includes('补丁'))) {
  fail('patchState=unsupported 时应报告补丁需要适配');
}

// 2) 事件结构全变了 → 必须报出来
write(path.join(transcriptsDir, 't1.jsonl'), [{ type: 'brand.new.event' }, { type: 'another.unknown' }]);
write(path.join(agentDir, 'events.jsonl'), [{ type: 'brand.new.event' }]);
const changed = buildCompatReport(base);
if (changed.ok) {
  fail('事件结构变化时应判定为需要关注');
}
const changedCount = changed.problems.filter((p) => p.includes('事件结构')).length;
if (changedCount !== 2) {
  fail(`应同时报出 transcript 与 agent 的结构变化，实际 ${changedCount} 条：${changed.problems.join('；')}`);
}

// 3) 目录缺失 → 报目录假设变了
const missingDir = buildCompatReport({ ...base, chatSessionsDir: path.join(root, 'nope') });
if (missingDir.ok || !missingDir.problems.some((p) => p.includes('chatSessions'))) {
  fail('chatSessions 目录为空/缺失时应报警');
}

// 4) probeEventTypes 对坏行/空文件要安全
const emptyFile = path.join(root, 'empty.jsonl');
fs.writeFileSync(emptyFile, '');
const probeEmpty = probeEventTypes(emptyFile);
if (probeEmpty.total !== 0 || probeEmpty.known !== 0) {
  fail('空文件应返回 0/0');
}
const mixedFile = path.join(root, 'mixed.jsonl');
fs.writeFileSync(mixedFile, 'not json\n{"type":"user.message"}\n{"broken":\n');
const probeMixed = probeEventTypes(mixedFile);
if (probeMixed.total !== 1 || probeMixed.known !== 1) {
  fail(`坏行应被跳过，实际 ${probeMixed.total}/${probeMixed.known}`);
}

console.log('PASS: 兼容性自检（健康/补丁失配/事件结构变化/目录缺失/坏行容错）');
