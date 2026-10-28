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
  const first = acquireOwnership(dir, 'window-A', 'proj-x');
  if (!first.owner) {
    throw new Error('第一个实例应当取得写者锁');
  }
  const second = acquireOwnership(dir, 'window-B', 'proj-x');
  if (second.owner) {
    throw new Error('第二个实例不应取得写者锁');
  }
  if (second.ownerLabel !== 'window-A') {
    throw new Error(`被动实例应能看到 owner 标签，实际: ${second.ownerLabel}`);
  }
  second.dispose();
  first.dispose();
  const third = acquireOwnership(dir, 'window-C', 'proj-x');
  if (!third.owner) {
    throw new Error('锁释放后新实例应能接管');
  }
  third.dispose();

  // 不同项目（不同 scope）必须各自拿到锁，互不影响
  const projA = acquireOwnership(dir, 'foldA', 'c:\\work\\project-a');
  const projB = acquireOwnership(dir, 'foldB', 'c:\\work\\project-b');
  if (!projA.owner || !projB.owner) {
    throw new Error(`不同项目应各自持有写者锁: A=${projA.owner} B=${projB.owner}`);
  }
  const projA2 = acquireOwnership(dir, 'foldA2', 'c:\\work\\project-a');
  if (projA2.owner) {
    throw new Error('同一个项目打开两个窗口时，第二个窗口必须进入被动模式');
  }
  if (projA2.ownerLabel !== 'foldA') {
    throw new Error(`被动窗口应看到同项目的 owner，实际: ${projA2.ownerLabel}`);
  }
  projA2.dispose();
  projA.dispose();
  projB.dispose();
  console.log('PASS: 多实例单写者锁（同项目仲裁，不同项目互不影响）');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
