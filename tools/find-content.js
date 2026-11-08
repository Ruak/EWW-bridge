// 在所有 transcript / agent 会话里搜关键字，定位是哪段会话产生了这段内容
const fs = require('fs');
const os = require('os');
const path = require('path');

const needle = process.argv[2] || '迁移检查点摘要';
const roots = [
  path.join(process.env.APPDATA || '', 'Code', 'User', 'workspaceStorage'),
  path.join(os.homedir(), '.copilot', 'session-state'),
];
const hits = [];
const walk = (dir, depth) => {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, depth - 1); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (Date.now() - st.mtimeMs > 48 * 3600 * 1000) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!text.includes(needle)) continue;
    hits.push({ full, mtime: st.mtimeMs, size: st.size });
  }
};
for (const r of roots) walk(r, 3);
hits.sort((a, b) => b.mtime - a.mtime);
for (const h of hits.slice(0, 6)) {
  console.log(new Date(h.mtime).toLocaleString(), Math.round(h.size / 1024) + 'KB', h.full);
}
if (!hits.length) console.log('未找到包含', needle, '的文件');
