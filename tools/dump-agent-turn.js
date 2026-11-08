// 转储最新 agent 会话（按 cwd 过滤）最后若干条正文，检查是否混入工具内容
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(os.homedir(), '.copilot', 'session-state');
const want = (process.argv[2] || 'homework').toLowerCase();
const entries = [];
for (const name of fs.readdirSync(root)) {
  const dir = path.join(root, name);
  const events = path.join(dir, 'events.jsonl');
  try {
    const st = fs.statSync(events);
    let cwd = '';
    try {
      const yaml = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
      const m = /^\s*cwd:\s*(.+)$/m.exec(yaml);
      cwd = m ? m[1].trim() : '';
    } catch {}
    entries.push({ name, events, mtime: st.mtimeMs, cwd });
  } catch {}
}
entries.sort((a, b) => b.mtime - a.mtime);
const target = entries.find((e) => e.cwd.toLowerCase().includes(want)) || entries[0];
console.log('session:', target.name, 'cwd:', target.cwd, 'mtime:', new Date(target.mtime).toLocaleString());
const lines = fs.readFileSync(target.events, 'utf8').trim().split('\n');
const out = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const d = o.data || {};
  if (o.type === 'user.message') out.push({ t: o.timestamp, type: 'user', text: d.content });
  else if (o.type === 'assistant.message') {
    const tools = (d.toolRequests || []).map((t) => t.name).join(',');
    out.push({ t: o.timestamp, type: 'assistant', text: d.content, tools });
  } else if (o.type === 'session.task_complete') {
    out.push({ t: o.timestamp, type: 'task_complete', text: d.summary });
  } else if (o.type === 'tool.execution_complete') {
    const res = d.result && (d.result.content || d.result.text || d.result);
    out.push({ t: o.timestamp, type: 'tool_complete:' + (d.toolName || ''), text: typeof res === 'string' ? res : JSON.stringify(res || '').slice(0, 120) });
  }
}
for (const row of out.slice(-14)) {
  const preview = (row.text || '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`${row.t}  ${row.type}  ${(row.text || '').length}ch  ${row.tools || ''}  ${preview}`);
}
