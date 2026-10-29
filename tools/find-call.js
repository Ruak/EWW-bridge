/* 列出 Copilot 扩展里某个调用的所有出现位置与上下文
 * 用法: node tools/find-call.js "<needle>" [max]
 */
const fs = require('fs');
const file = 'd:\\VS Code\\Microsoft VS Code\\e646868227\\resources\\app\\extensions\\copilot\\dist\\extension.js';
const needle = process.argv[2];
const max = Number(process.argv[3] || 20);
const text = fs.readFileSync(file, 'utf8');
let idx = -1;
let count = 0;
while (count < max) {
  idx = text.indexOf(needle, idx + 1);
  if (idx < 0) break;
  const before = text.slice(Math.max(0, idx - 160), idx).replace(/\s+/g, ' ');
  const after = text.slice(idx, idx + 120).replace(/\s+/g, ' ');
  console.log(`#${count} @${idx}\n  ...${before}\n  >>> ${after}\n`);
  count += 1;
}
console.log('total shown', count);
