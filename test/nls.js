/* package.nls 一致性单测：node test/nls.js
 * 校验 package.json 里所有 %key% 占位符在英文（默认）与简体中文里都有非空值，
 * 且两种语言的键集合完全一致（避免发布后命令面板出现 %key%）。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const required = new Set();
const walk = (node) => {
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node && typeof node === 'object') {
    Object.values(node).forEach(walk);
    return;
  }
  if (typeof node === 'string') {
    const m = /^%([^%]+)%$/.exec(node);
    if (m) {
      required.add(m[1]);
    }
  }
};
walk(pkg.contributes);

if (required.size === 0) {
  throw new Error('package.json 里没有找到 %key% 本地化占位符');
}

const tables = ['package.nls.json', 'package.nls.zh-cn.json'].map((file) => ({
  file,
  data: JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')),
}));

for (const { file, data } of tables) {
  const missing = [...required].filter((key) => typeof data[key] !== 'string' || !data[key].trim());
  if (missing.length > 0) {
    throw new Error(`${file} 缺少或为空: ${missing.join(', ')}`);
  }
  const extra = Object.keys(data).filter((key) => !required.has(key));
  if (extra.length > 0) {
    throw new Error(`${file} 存在 package.json 未引用的键: ${extra.join(', ')}`);
  }
}

const [en, zh] = tables.map((t) => t.data);
const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
if (JSON.stringify(enKeys) !== JSON.stringify(zhKeys)) {
  throw new Error('英文与简中的键集合不一致');
}
if (/[\u4e00-\u9fa5]/.test(en['command.connect'])) {
  throw new Error('package.nls.json（默认语言）应当是英文');
}
if (!/[\u4e00-\u9fa5]/.test(zh['command.connect'])) {
  throw new Error('package.nls.zh-cn.json 应当是简体中文');
}

console.log(`PASS: nls 占位符 ${required.size} 个，英文/简中均完整且键一致`);
