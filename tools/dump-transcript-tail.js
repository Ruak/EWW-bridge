// 转储 transcript 尾部事件（类型/长度/预览）
const fs = require('fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
const rows = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const d = o.data || {};
  const text = typeof d.content === 'string' ? d.content : '';
  const tools = (d.toolRequests || []).map((t) => t.name + (t.arguments && t.arguments.path ? ':' + String(t.arguments.path).slice(-28) : '')).join(',');
  rows.push({ t: o.timestamp, type: o.type, len: text.length, tools, text });
}
for (const r of rows.slice(-Number(process.argv[3] || 16))) {
  const preview = (r.text || '').replace(/\s+/g, ' ').slice(0, 120);
  console.log(`${r.t}  ${r.type}  ${r.len}ch  ${r.tools || ''}\n    ${preview}`);
}
