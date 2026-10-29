/* 按关键字找“这是哪个会话”：扫描所有工作区的 transcript / chatSessions
 * 用法: node tools/find-session.js "<关键字>" [会话数上限]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const keyword = process.argv[2];
if (!keyword) {
  console.error('usage: node tools/find-session.js "<keyword>"');
  process.exit(1);
}
const root = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
const t0 = Date.now();
const hits = [];

function folderOf(base) {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(base, 'workspace.json'), 'utf8'));
    return decodeURIComponent(String(ws.folder || ws.workspace || '').replace('file:///', ''));
  } catch {
    return '(unknown)';
  }
}

function scan(file, kind, folder) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size > 400 * 1024 * 1024) return; // 超大文件跳过（只靠 mtime 判断）
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const idx = text.indexOf(keyword);
  if (idx < 0) return;
  const st = fs.statSync(file);
  hits.push({
    kind,
    id: path.basename(file, '.jsonl'),
    file,
    folder,
    size,
    mtime: st.mtimeMs,
    birth: st.birthtimeMs,
    snippet: text
      .slice(Math.max(0, idx - 120), idx + 160)
      .replace(/\s+/g, ' ')
      .slice(0, 280),
  });
}

const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
for (const dir of dirs) {
  const base = path.join(root, dir.name);
  const folder = folderOf(base);
  const tdir = path.join(base, 'GitHub.copilot-chat', 'transcripts');
  const sdir = path.join(base, 'chatSessions');
  for (const [dirPath, kind] of [
    [tdir, 'transcript'],
    [sdir, 'chatSessions'],
  ]) {
    if (!fs.existsSync(dirPath)) continue;
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.jsonl')) continue;
      scan(path.join(dirPath, f), kind, folder);
    }
  }
}

const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
hits.sort((a, b) => b.mtime - a.mtime);
for (const h of hits) {
  console.log(`\n[${h.kind}] ${h.id}`);
  console.log(`  workspace: ${h.folder}`);
  console.log(`  size: ${(h.size / 1048576).toFixed(1)}MB  写入 ${fmt(h.mtime)}  创建 ${fmt(h.birth)}`);
  console.log(`  context: ...${h.snippet}...`);
}
console.log(`\n命中 ${hits.length} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
