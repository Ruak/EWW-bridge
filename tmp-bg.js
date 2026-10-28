// temp: confirm background-terminal wait pattern in transcript
const fs = require('fs');
const file = 'c:\\Users\\huangdan\\AppData\\Roaming\\Code\\User\\workspaceStorage\\8ec0bba1e0021af4e28134bbfcf6030d\\GitHub.copilot-chat\\transcripts\\f1aa123d-89b1-451f-b7dd-e02491818a3f.jsonl';
const size = fs.statSync(file).size;
const CH = 512 * 1024;
const fd = fs.openSync(file, 'r');
const start = Math.max(0, size - CH);
const buf = Buffer.alloc(size - start);
fs.readSync(fd, buf, 0, buf.length, start);
fs.closeSync(fd);
const events = [];
for (const line of buf.toString('utf8').split('\n')) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch {}
}
const tail = events.slice(-40);
for (const e of tail) {
  const d = e.data || {};
  const t = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '-';
  let extra = '';
  if (e.type === 'tool.execution_start') {
    const args = d.arguments || {};
    extra = `${d.toolName} keys=${Object.keys(args).join(',')}`;
    if (args.command) extra += ` cmd=${String(args.command).slice(0, 60).replace(/\s+/g, ' ')}`;
    if (args.isBackground !== undefined) extra += ` isBackground=${args.isBackground}`;
  } else if (e.type === 'user.message') {
    extra = String(d.content || '').slice(0, 100).replace(/\s+/g, ' ');
  } else if (e.type === 'assistant.message') {
    extra = `content=${(d.content || '').length}ch reasoning=${(d.reasoningText || '').length}ch tools=${(d.toolRequests || []).length}`;
  }
  console.log(t, e.type, extra);
}
