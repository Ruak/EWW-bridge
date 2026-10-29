// 列出 agent 会话 events.jsonl 里的正文事件（长度 + 工具），用于对照同步结果
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(os.homedir(), '.copilot', 'session-state');
const target = process.argv[2];
const file = target ? target : (() => {
  let best;
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir, 'events.jsonl');
    try {
      const st = fs.statSync(p);
      if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs };
    } catch { /* skip */ }
  }
  return best && best.p;
})();
if (!file) {
  console.log('未找到 events.jsonl');
  process.exit(1);
}
console.log('file:', file);
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
const skip = new Set(['hook.start', 'hook.end']);
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (skip.has(o.type)) continue;
  const d = o.data || {};
  const text = typeof d.content === 'string' ? d.content : '';
  const tools = (d.toolRequests || []).map((t) => t.name).join(',');
  const prefix = `${o.timestamp}  ${o.type}`;
  if (!text && !tools && o.type !== 'assistant.turn_start' && o.type !== 'assistant.turn_end') continue;
  console.log(`${prefix}  ${text.length}ch  ${tools}  ${text ? JSON.stringify(text.slice(0, 60)) : ''}`);
}
