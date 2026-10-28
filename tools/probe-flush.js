/* 后台等待期间的落盘时序探针：node tools/probe-flush.js [秒数]
 * 每 200ms 采样 transcript / chatSessions 的文件大小，记录“新字节到达时刻”，
 * 并把新追加的 transcript 行的事件时间戳一起打印，用来量化缓冲落盘延迟。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const seconds = Number(process.argv[2] || 900);
const base =
  process.env.EWW_PROBE_BASE ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage', '8ec0bba1e0021af4e28134bbfcf6030d');
const transcriptDir = path.join(base, 'GitHub.copilot-chat', 'transcripts');
const sessionDir = path.join(base, 'chatSessions');
const out = path.join(os.homedir(), 'eww-probe.log');

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

let transcript = newest(transcriptDir, '.jsonl');
let transcriptSize = transcript ? fs.statSync(transcript).size : 0;
let session = newest(sessionDir, '.jsonl');
let sessionSize = session ? fs.statSync(session).size : 0;
let transcriptBuffer = '';
log(
  `probe start: transcript=${transcript ? path.basename(transcript).slice(0, 8) : '-'}@${transcriptSize}B ` +
    `session=${session ? path.basename(session).slice(0, 8) : '-'}@${sessionSize}B`,
);

function readDelta(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const started = Date.now();
const timer = setInterval(() => {
  try {
    const nowTranscript = newest(transcriptDir, '.jsonl');
    if (nowTranscript && nowTranscript !== transcript) {
      transcript = nowTranscript;
      transcriptSize = 0;
      transcriptBuffer = '';
      log(`transcript switched to ${path.basename(transcript).slice(0, 8)}`);
    }
    if (transcript) {
      const size = fs.statSync(transcript).size;
      if (size > transcriptSize) {
        const delta = readDelta(transcript, transcriptSize, size);
        transcriptSize = size;
        transcriptBuffer += delta;
        const lines = transcriptBuffer.split('\n');
        transcriptBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            log(`transcript +${delta.length}B unparsable line`);
            continue;
          }
          const d = ev.data || {};
          const evTs = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
          const extra =
            ev.type === 'user.message'
              ? String(d.content || '').slice(0, 60).replace(/\s+/g, ' ')
              : ev.type === 'assistant.message'
                ? `content=${(d.content || '').length}ch tools=${(d.request || d.toolRequests || []).length}`
                : ev.type === 'tool.execution_start'
                  ? `tool=${d.toolName}`
                  : '';
          log(`transcript +${delta.length}B line evTs=${evTs} ${ev.type} ${extra}`);
        }
      }
    }
    const nowSession = newest(sessionDir, '.jsonl');
    if (nowSession && nowSession !== session) {
      session = nowSession;
      sessionSize = 0;
      log(`session switched to ${path.basename(session).slice(0, 8)}`);
    }
    if (session) {
      const size = fs.statSync(session).size;
      if (size > sessionSize) {
        log(`session +${size - sessionSize}B (total ${size}B)`);
        sessionSize = size;
      }
    }
    if (Date.now() - started > seconds * 1000) {
      clearInterval(timer);
      log('probe done');
      process.exit(0);
    }
  } catch (error) {
    log(`probe error: ${String(error).slice(0, 120)}`);
  }
}, 200);
