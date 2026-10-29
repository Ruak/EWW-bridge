/* 按标记串导出 Copilot 扩展代码片段，便于分析缓冲/落盘策略
 * 用法:
 *   node tools/dump-copilot-transcript.js --find "<needle>" [occurrence] [len]
 *   node tools/dump-copilot-transcript.js --offset <n> [len]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const file = 'd:\\VS Code\\Microsoft VS Code\\e646868227\\resources\\app\\extensions\\copilot\\dist\\extension.js';
const args = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');

let start = 0;
let len = 4000;
if (args[0] === '--find') {
  const needle = args[1];
  const occurrence = Number(args[2] || 1);
  let idx = -1;
  for (let i = 0; i < occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) break;
  }
  if (idx < 0) {
    console.log('not found:', needle);
    process.exit(1);
  }
  start = Math.max(0, idx - 200);
  len = Number(args[3] || 4000) + 200;
  console.log('found at', idx);
} else {
  start = Number(args[1] || 0);
  len = Number(args[2] || 4000);
}

const chunk = text.slice(start, start + len);
const pretty = chunk
  .replace(/;/g, ';\n')
  .replace(/\{/g, '{\n')
  .replace(/\}/g, '}\n')
  .split('\n')
  .filter((l) => l.trim())
  .join('\n');
const out = path.join(os.homedir(), 'copilot-transcript-snippet.txt');
fs.writeFileSync(out, pretty, 'utf8');
console.log('written', out, pretty.length, 'chars, from', start);
