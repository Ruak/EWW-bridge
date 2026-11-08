// 查看 chatSessions 最后一个请求的 response 分片种类与新文案，判断是否有非正文内容进入
const fs = require('fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
// 应用补丁流：kind0 快照 / kind1 赋值 / kind2 append
let state = {};
const applyOp = (op) => {
  if (!op || typeof op !== 'object') return;
  const kind = op.kind;
  if (kind === 0) {
    state = op.v ?? state;
  } else if (kind === 1) {
    // 按 path 赋值
    const p = op.k;
    if (Array.isArray(p) && p.length) {
      let cur = state;
      for (let i = 0; i < p.length - 1; i++) {
        if (cur[p[i]] === undefined) cur[p[i]] = {};
        cur = cur[p[i]];
      }
      cur[p[p.length - 1]] = op.v;
    }
  } else if (kind === 2) {
    // 向数组追加
    const p = op.k;
    if (Array.isArray(p) && p.length) {
      let cur = state;
      for (let i = 0; i < p.length - 1; i++) {
        if (cur[p[i]] === undefined) cur[p[i]] = [];
        cur = cur[p[i]];
      }
      const key = p[p.length - 1];
      if (!Array.isArray(cur[key])) cur[key] = [];
      cur[key].push(op.v);
    }
  }
};
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  applyOp(o);
}
const requests = state.requests || [];
console.log('requests:', requests.length);
const last = requests[requests.length - 1];
if (!last) process.exit(0);
console.log('last request message:', JSON.stringify(String(last.message?.text || '').slice(0, 80)));
console.log('completed:', !!last.result);
const resp = last.response || [];
console.log('response parts:', resp.length);
for (const part of resp.slice(-12)) {
  const kind = part.kind || '(no-kind)';
  const val = typeof part.value === 'string' ? part.value : JSON.stringify(part.value || '').slice(0, 100);
  console.log(`- ${kind}  ${val.length}ch  ${String(val).replace(/\s+/g, ' ').slice(0, 110)}`);
}
