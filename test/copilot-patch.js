/* 内置 Copilot 落盘补丁模块单测：node test/copilot-patch.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eww-copilot-'));
const target = path.join(root, 'resources', 'app', 'extensions', 'copilot', 'dist', 'extension.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
const originalBundle = [
  'class SessionTranscript{',
  'constructor(){this._activeSessions=new Map()}',
  '_bufferEntry(e,n,r){let o=this._activeSessions.get(e);o.push(n);return o}',
  'async flush(e){let n=this._activeSessions.get(e);return n.length}',
  '}',
  'module.exports={SessionTranscript};',
].join('\n');
fs.writeFileSync(target, originalBundle, 'utf8');

const originalLoad = Module._load;
let settingValue = target;
Module._load = function (request) {
  if (request === 'vscode') {
    const channel = { appendLine() {}, show() {}, dispose() {} };
    return {
      version: '1.143.1',
      window: { createOutputChannel: () => channel },
      workspace: { getConfiguration: () => ({ get: () => settingValue }) },
      extensions: { getExtension: () => undefined },
      env: { appRoot: root },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { applyCopilotPatch, copilotExtensionFile, copilotPatchStatus, restoreCopilotPatch } = require('../out/copilotPatch.js');

const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};

if (copilotPatchStatus().state !== 'clean') {
  fail(`初始状态应为 clean，实际 ${copilotPatchStatus().state}`);
}

const first = applyCopilotPatch();
if (!first.ok || first.alreadyPatched) {
  fail(`首次打补丁失败：${first.message}`);
}
const patchedCode = fs.readFileSync(target, 'utf8');
if (!patchedCode.includes('_bufferEntryCore')) {
  fail('补丁后缺少 _bufferEntryCore');
}
if (!patchedCode.includes('void this.flush(e)')) {
  fail('补丁后缺少即时 flush 调用');
}
if (!fs.existsSync(`${target}.eww-orig`)) {
  fail('缺少备份文件');
}
if (copilotPatchStatus().state !== 'patched') {
  fail('状态应为 patched');
}

const second = applyCopilotPatch();
if (!second.ok || !second.alreadyPatched) {
  fail('重复打补丁应返回 alreadyPatched');
}

const restored = restoreCopilotPatch();
if (!restored.ok) {
  fail(`还原失败：${restored.message}`);
}
if (fs.readFileSync(target, 'utf8') !== originalBundle) {
  fail('还原后内容与原始文件不一致');
}

// 锚点不匹配：应该拒绝改动
fs.writeFileSync(target, 'class X{other(){return 1}}', 'utf8');
fs.rmSync(`${target}.eww-orig`, { force: true });
const rejected = applyCopilotPatch();
if (rejected.ok) {
  fail('锚点不匹配时不应写入');
}
if (rejected.alreadyPatched) {
  fail('锚点不匹配时不应报已打补丁');
}
if (fs.readFileSync(target, 'utf8') !== 'class X{other(){return 1}}') {
  fail('锚点不匹配时文件被改动');
}

// 设置里填了不存在的路径：不能把无效路径当结果（会回退到自动探测，没有就返回 undefined）
settingValue = path.join(root, 'nope', 'extension.js');
const resolved = copilotExtensionFile();
if (resolved === settingValue) {
  fail('无效的设置路径不应被当成目标文件');
}
if (copilotPatchStatus().state === 'missing' && resolved !== undefined) {
  fail('状态与定位结果不一致');
}

console.log('PASS: 内置 Copilot 补丁（打补丁/幂等/还原/锚点不匹配/文件缺失）');
