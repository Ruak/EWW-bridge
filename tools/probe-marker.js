/* 标记探针：node tools/probe-marker.js <标记串> [秒数] [workspaceStorage hash]
 * 同时监视 transcript 与 chatSessions 的新增字节，谁先出现标记串就记录下来，
 * 用来判断“正文到底先落到哪个文件”。chatSessions 增量较大时只读新增部分。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const markerArg = process.argv[2];
const seconds = Number(process.argv[3] || 300);
const hash = process.argv[4] || '56cd9cc3297d26e12e6b21456fb3748c';
let marker = markerArg;
if (!marker || marker === '--auto') {
  // 自动生成标记并写到文件：避免标记出现在工具命令行/参数里，造成“假命中”
  marker = `MARK-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  try {
    fs.writeFileSync(path.join(os.homedir(), 'eww-marker.txt'), marker, 'utf8');
  } catch {}
}
if (!marker) {
  console.error('usage: node tools/probe-marker.js [<marker>|--auto] [seconds] [hash]');
  process.exit(1);
}
const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage', hash);
const transcriptDir = path.join(base, 'GitHub.copilot-chat', 'transcripts');
const sessionDir = path.join(base, 'chatSessions');
const out = path.join(os.homedir(), 'eww-probe-marker.log');

function recv() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function log(line) {
  const text = `[recv ${recv()}] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(out, text + '\n', 'utf8');
  } catch {}
}
function newest(dir, ext) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f))
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0]?.p;
  } catch {
    return undefined;
  }
}
function readDelta(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try {
    const cap = Math.min(to - from, 8 * 1024 * 1024);
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, from);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const transcriptFile = newest(transcriptDir, '.jsonl');
const sessionFile = newest(sessionDir, '.jsonl');
const state = {
  transcript: { file: transcriptFile, size: transcriptFile ? fs.statSync(transcriptFile).size : 0, hit: false, delta: '' },
  session: { file: sessionFile, size: sessionFile ? fs.statSync(sessionFile).size : 0, hit: false, delta: '' },
};
log(`marker probe start: marker=${marker} transcript=${path.basename(transcriptFile || '-').slice(0, 8)} session=${path.basename(sessionFile || '-').slice(0, 8)}`);

const started = Date.now();
const timer = setInterval(() => {
  try {
    for (const key of ['transcript', 'session']) {
      const st = state[key];
      if (!st.file || st.hit) continue;
      const size = fs.statSync(st.file).size;
      if (size <= st.size) continue;
      const delta = readDelta(st.file, st.size, size);
      // 跨块匹配：保留上一块尾部，避免标记被切断
      const haystack = st.delta + delta;
      st.delta = haystack.slice(-marker.length * 2);
      st.size = size;
      log(`${key} +${size - (size - delta.length)}B total=${size}B`);
      if (haystack.includes(marker)) {
        st.hit = true;
        log(`>>> marker FOUND in ${key} (${size}B)`);
      }
    }
    if (state.transcript.hit && state.session.hit) {
      clearInterval(timer);
      log('both files contain marker, probe done');
      process.exit(0);
    }
    if (Date.now() - started > seconds * 1000) {
      clearInterval(timer);
      log(`probe timeout; hits transcript=${state.transcript.hit} session=${state.session.hit}`);
      process.exit(0);
    }
  } catch (error) {
    log(`probe error: ${String(error).slice(0, 120)}`);
  }
}, 200);
