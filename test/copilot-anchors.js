/* 补丁锚点鲁棒性单测：node test/copilot-anchors.js
 * 目的：VS Code 升级后 Copilot 打包里的压缩器变量名可能变，锚点不能依赖具体字母。
 */
const vm = require('vm');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    const channel = { appendLine() {}, show() {}, dispose() {} };
    return {
      version: '1.143.1',
      window: { createOutputChannel: () => channel },
      workspace: { getConfiguration: () => ({ get: () => '' }) },
      extensions: { getExtension: () => undefined },
      env: { appRoot: path.join(__dirname, '..') },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { buildPatchedCode } = require('../out/copilotPatch.js');

const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};

const variants = [
  ['经典压缩', 'e', 'class S{_bufferEntry(e,n,r){let o=this._activeSessions.get(e);return o}async flush(e){let n=this._activeSessions.get(e);return n.length}}'],
  ['变量改名', 't', 'class S{_bufferEntry(t,i,r){let s=this._activeSessions.get(t);return s}async flush(t){let i=this._activeSessions.get(t);return i.length}}'],
  ['特殊字符', '$a', 'class S{_bufferEntry($a,_b,c2){let x=this._activeSessions.get($a);return x}async flush($a){let x=this._activeSessions.get($a);return x.length}}'],
  ['带空格', 'e', 'class S{_bufferEntry(e, n, r) {let o = this._activeSessions.get(e);return o}async flush(e) {let n = this._activeSessions.get(e);return n.length}}'],
];

for (const [label, firstParam, source] of variants) {
  const built = buildPatchedCode(source);
  if (!built.ok) {
    fail(`${label}: 应能打补丁，实际 ${built.reason}`);
  }
  const code = built.code;
  if (!code.includes('_bufferEntryCore(')) {
    fail(`${label}: 缺少 _bufferEntryCore`);
  }
  if (!code.includes(`void this.flush(${firstParam})`)) {
    fail(`${label}: 包装方法没有用原参数名调用 flush`);
  }
  if (code.includes('_bufferEntry(e,n,r){this._bufferEntryCore(e,n,r)') && firstParam !== 'e') {
    fail(`${label}: 包装方法写死了 e,n,r`);
  }
  try {
    new vm.Script(code);
  } catch (error) {
    fail(`${label}: 补丁后语法不合法：${error.message}`);
  }
  const again = buildPatchedCode(code);
  if (again.ok || again.reason !== 'already') {
    fail(`${label}: 重复打补丁应识别为 already`);
  }
}

// 结构真的变了：必须拒绝，而不是瞎写
const broken = buildPatchedCode('class S{_bufferEntry(e){return 1}}async flush(e){return 2}');
if (broken.ok || broken.reason !== 'define-anchor') {
  fail(`结构不匹配时应返回 define-anchor，实际 ${broken.ok} ${broken.reason}`);
}

console.log(`PASS: 补丁锚点抗压缩变量改名（${variants.length} 种写法 + 拒绝不匹配结构）`);
