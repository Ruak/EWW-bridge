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

// 回归：bundle 里别的类（如新版 ChatDebugFileLogger）也有同形态的 flush，且排在目标类之前。
// 包装方法必须插回目标类，否则目标类丢了 _bufferEntry → Copilot 对话请求直接报
// "this._bufferEntry is not a function"。
const twoClassSource = [
  'class Other{constructor(){this._activeSessions=new Map()}' +
    '_bufferEntry(n,r){let o=this._activeSessions.get(n);return o}' +
    'async flush(n){let r=this._activeSessions.get(n);return r.length}}',
  'class S{constructor(){this._activeSessions=new Map()}' +
    '_bufferEntry(e,n,r){let o=this._activeSessions.get(e);return o}' +
    'async flush(e){let n=this._activeSessions.get(e);return n.length}}',
  'module.exports={Other,S};',
].join('');
const built2 = buildPatchedCode(twoClassSource);
if (!built2.ok) {
  fail(`双类 bundle：应能打补丁，实际 ${built2.reason}`);
}
const code2 = built2.code;
if (code2.indexOf('_bufferEntryCore(') < code2.indexOf('class S')) {
  fail('双类 bundle：改名落到了别的类里');
}
if (!code2.includes('void this.flush(e).catch(()=>{})}_bufferEntryCore(e,n,r)')) {
  fail('双类 bundle：包装方法没有紧贴目标类的 core 定义');
}
try {
  new vm.Script(code2);
} catch (error) {
  fail(`双类 bundle：补丁后语法不合法：${error.message}`);
}
const mod = { exports: {} };
new Function('module', 'exports', code2)(mod, mod.exports);
const target = new mod.exports.S();
const other = new mod.exports.Other();
if (typeof target._bufferEntry !== 'function' || typeof target._bufferEntryCore !== 'function') {
  fail('双类 bundle：目标类缺少 _bufferEntry/_bufferEntryCore');
}
if (typeof other._bufferEntry !== 'function' || typeof other._bufferEntryCore === 'function') {
  fail('双类 bundle：另一个类被误改');
}
target._bufferEntry('s1', { type: 'x' }, undefined);

// 半成品补丁（旧版把定义改名了、包装方法插到别的类）应能就地修好
const halfPatched = twoClassSource
  .replace('class S{constructor(){this._activeSessions=new Map()}_bufferEntry(e,n,r)', 'class S{constructor(){this._activeSessions=new Map()}_bufferEntryCore(e,n,r)')
  .replace(
    'async flush(n){let r=this._activeSessions.get(n);return r.length}}',
    'async flush(n){let r=this._activeSessions.get(n);return r.length}_bufferEntry(n,r,x){this._bufferEntryCore(n,r,x)}}',
  );
const healed = buildPatchedCode(halfPatched);
if (!healed.ok) {
  fail(`半成品补丁：应能自愈，实际 ${healed.reason}`);
}
const code3 = healed.code;
try {
  new vm.Script(code3);
} catch (error) {
  fail(`半成品补丁：自愈后语法不合法：${error.message}`);
}
const mod3 = { exports: {} };
new Function('module', 'exports', code3)(mod3, mod3.exports);
const healedTarget = new mod3.exports.S();
if (typeof healedTarget._bufferEntry !== 'function') {
  fail('半成品补丁：自愈后目标类仍缺少 _bufferEntry');
}
healedTarget._bufferEntry('s1', { type: 'x' }, undefined);
const again3 = buildPatchedCode(code3);
if (again3.ok || again3.reason !== 'already') {
  fail(`半成品补丁：自愈后重复打补丁应识别为 already，实际 ${again3.reason}`);
}

// 结构真的变了：必须拒绝，而不是瞎写
const broken = buildPatchedCode('class S{_bufferEntry(e){return 1}}async flush(e){return 2}');
if (broken.ok || broken.reason !== 'define-anchor') {
  fail(`结构不匹配时应返回 define-anchor，实际 ${broken.ok} ${broken.reason}`);
}

console.log(
  `PASS: 补丁锚点抗压缩变量改名（${variants.length} 种写法 + 双类 bundle 插对位置 + 半成品自愈 + 拒绝不匹配结构）`,
);
