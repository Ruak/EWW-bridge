/* 在 VS Code 安装目录里定位“聊天正文/transcript 写盘”的实现位置
 * 用法: node tools/find-transcript-writer.js "<VS Code app 目录>"
 */
const fs = require('fs');
const path = require('path');

const appRoot = process.argv[2] || 'd:\\VS Code\\Microsoft VS Code\\e646868227\\resources\\app';
const targets = [
  path.join(appRoot, 'extensions', 'copilot'),
  path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
];
const needles = ['transcripts', 'assistant.turn_end', 'chatSessions'];

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (p.endsWith('.js')) out.push(p);
    return;
  }
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    walk(path.join(p, entry.name), out);
  }
}

const files = [];
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  if (fs.statSync(t).isFile()) files.push(t);
  else walk(t, files);
}

for (const file of files) {
  const size = fs.statSync(file).size;
  if (size > 80 * 1024 * 1024) continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const needle of needles) {
    let idx = text.indexOf(needle);
    let count = 0;
    while (idx >= 0 && count < 3) {
      const ctx = text.slice(Math.max(0, idx - 140), Math.min(text.length, idx + 160)).replace(/\s+/g, ' ');
      console.log(`\n[${path.basename(file)} ${(size / 1048576).toFixed(1)}MB] "${needle}" @${idx}`);
      console.log('  ' + ctx);
      idx = text.indexOf(needle, idx + needle.length);
      count += 1;
    }
  }
}
