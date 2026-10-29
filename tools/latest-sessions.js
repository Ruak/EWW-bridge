/* 列出最近活动的聊天会话（跨所有工作区），用于确认“当前对话的 session id”
 * 用法: node tools/latest-sessions.js [数量]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const limit = Number(process.argv[2] || 8);
const root = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
const rows = [];

let dirs = [];
try {
  dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
} catch {
  console.error('找不到 workspaceStorage:', root);
  process.exit(1);
}

for (const dir of dirs) {
  const base = path.join(root, dir.name);
  const sessions = path.join(base, 'chatSessions');
  if (!fs.existsSync(sessions)) continue;
  let folder = '';
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(base, 'workspace.json'), 'utf8'));
    folder = decodeURIComponent(String(ws.folder || ws.workspace || '').replace('file:///', ''));
  } catch {
    folder = '(unknown)';
  }
  for (const f of fs.readdirSync(sessions)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(sessions, f);
    try {
      const st = fs.statSync(p);
      rows.push({
        id: path.basename(f, '.jsonl'),
        mtime: st.mtimeMs,
        birth: st.birthtimeMs,
        size: st.size,
        folder,
      });
    } catch {}
  }
}

rows.sort((a, b) => b.mtime - a.mtime);
const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
for (const r of rows.slice(0, limit)) {
  console.log(
    `${r.id}  ${(r.size / 1048576).toFixed(1).padStart(6)}MB  写入 ${fmt(r.mtime)}  创建 ${fmt(r.birth)}  ${r.folder}`,
  );
}
console.log(`\n共 ${rows.length} 个会话；按“写入时间”排序，最上面一行通常就是当前对话（发一条消息后会立刻刷新）。`);
