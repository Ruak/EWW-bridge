// 用真实目录跑一次兼容性自检（不依赖 vscode）
const os = require('os');
const path = require('path');
const Module = require('module');

// 给 copilotPatch 提供最小 vscode 桩
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    const channel = { appendLine() {}, show() {}, dispose() {} };
    return {
      version: '1.143.1',
      window: { createOutputChannel: () => channel },
      workspace: { getConfiguration: () => ({ get: () => '' }) },
      extensions: { getExtension: () => undefined },
      env: { appRoot: process.env.EWW_APP_ROOT || '' },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { buildCompatReport } = require('../out/compat.js');
const { copilotPatchStatus } = require('../out/copilotPatch.js');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const hash = process.argv[2] || '56cd9cc3297d26e12e6b21456fb3748c';
const root = path.join(appData, 'Code', 'User', 'workspaceStorage', hash);

let patch = { state: 'unknown' };
try {
  patch = copilotPatchStatus();
} catch {
  /* 没有 vscode 时忽略 */
}

const report = buildCompatReport({
  vscodeVersion: process.argv[3] || '1.143.1',
  extensionVersion: require('../package.json').version,
  patchState: patch.state,
  patchFile: patch.file,
  chatSessionsDir: path.join(root, 'chatSessions'),
  transcriptDir: path.join(root, 'GitHub.copilot-chat', 'transcripts'),
  agentRoot: path.join(os.homedir(), '.copilot', 'session-state'),
  workspaceFolder: process.cwd(),
});
console.log(report.lines.join('\n'));
console.log(report.ok ? '\n=> OK' : '\n=> 需要关注');
