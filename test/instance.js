/* 回归测试：多窗口单写者锁，第二个实例必须进入被动模式。
 * 运行：node test/instance.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) } };
  }
  return originalLoad.apply(this, arguments);
};

process.env.EWW_NO_FILE_LOG = '1';
const { acquireOwnership } = require('../out/instance.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-bridge-owner-'));
try {
  const first = acquireOwnership(dir, 'window-A');
  if (!first.owner) {
    throw new Error('第一个实例应当取得写者锁');
  }
  const second = acquireOwnership(dir, 'window-B');
  if (second.owner) {
    throw new Error('第二个实例不应取得写者锁');
  }
  if (second.ownerLabel !== 'window-A') {
    throw new Error(`被动实例应能看到 owner 标签，实际: ${second.ownerLabel}`);
  }
  second.dispose();
  first.dispose();
  const third = acquireOwnership(dir, 'window-C');
  if (!third.owner) {
    throw new Error('锁释放后新实例应能接管');
  }
  third.dispose();
  console.log('PASS: 多实例单写者锁（第二个实例进入被动模式，释放后可接管）');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
