/* 在扩展宿主之外模拟 VS Code API，验证 activate 全链路不报错。
 * 运行：node test/activate.js
 */
process.env.EWW_NO_FILE_LOG = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const output = [];
const commands = new Set();
const disposables = [];

const channel = {
  appendLine(line) {
    output.push(line);
  },
  show() {},
  dispose() {},
};

const statusItem = {
  text: '',
  tooltip: '',
  command: '',
  backgroundColor: undefined,
  show() {},
  dispose() {},
};

function configSection() {
  const values = {
    enabled: true,
    'feishu.appId': '',
    'feishu.defaultChatId': '',
    'forward.userMessages': true,
    'forward.assistantMessages': true,
    'forward.toolCalls': false,
    'forward.thinking': false,
    'forward.idleMs': 2500,
    'security.allowedOpenIds': [],
    'security.prefix': '',
    'inject.newChat': false,
    'inject.timeoutMs': 900000,
  };
  return {
    get(key, fallback) {
      return values[key] !== undefined ? values[key] : fallback;
    },
    update: async () => {},
  };
}

const vscodeStub = {
  window: {
    createOutputChannel: () => channel,
    createStatusBarItem: () => statusItem,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
  },
  workspace: {
    getConfiguration: () => configSection(),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id) => {
      commands.add(id);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
    getCommands: async () => Array.from(commands),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {},
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.apply(this, arguments);
};

const extension = require('../out/extension.js');

// 自建临时工作区（不依赖本机 VS Code 的 workspaceStorage）：CI 在 Linux 上也能跑
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-activate-'));
const hashDir = path.join(tmpRoot, 'workspaceStorage', 'ci-workspace');
const chatSessionsDir = path.join(hashDir, 'chatSessions');
fs.mkdirSync(chatSessionsDir, { recursive: true });
fs.writeFileSync(
  path.join(chatSessionsDir, 'ci-session.jsonl'),
  JSON.stringify({
    kind: 0,
    v: {
      version: 3,
      sessionId: 'ci-session',
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
  }) + '\n',
);

const context = {
  subscriptions: { push: (...items) => disposables.push(...items) },
  storageUri: vscodeStub.Uri.file(path.join(hashDir, 'eww-local.eww-bridge')),
  globalStorageUri: vscodeStub.Uri.file(path.join(tmpRoot, 'globalStorage', 'eww-local.eww-bridge')),
  globalState: { get: (_key, fallback) => fallback, update: async () => {} },
  workspaceState: { get: (_key, fallback) => fallback, update: async () => {} },
  secrets: { get: async () => undefined, store: async () => {} },
  extensionUri: vscodeStub.Uri.file(path.resolve(__dirname, '..')),
};

(async () => {
  await extension.activate(context);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const logText = output.join('\n');
  console.log('--- 命令 ---');
  console.log(Array.from(commands).join('\n'));
  console.log('--- 日志 ---');
  console.log(logText);

  if (commands.size < 8) {
    console.error('FAIL: 命令注册不完整');
    process.exit(1);
  }
  if (!logText.includes('watcher: attached')) {
    console.error('FAIL: 未附加到会话文件');
    process.exit(1);
  }
  if (!logText.includes('feishu: 未配置 App ID')) {
    console.error('FAIL: 未按预期跳过飞书连接');
    process.exit(1);
  }

  extension.deactivate();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nPASS: activate 全链路正常（watcher 已附加，飞书缺省未连接）');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(1);
});
