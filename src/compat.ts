import * as fs from 'fs';
import * as path from 'path';

/**
 * 兼容性自检：VS Code / Copilot 升级后，用来快速判断哪些假设还成立。
 * 不 import vscode，方便单测（ts 编译到 out/ 后用 node 直接跑）。
 */
export interface CompatInput {
  vscodeVersion?: string;
  extensionVersion?: string;
  copilotVersion?: string;
  patchState: string;
  patchFile?: string;
  scriptPath?: string;
  chatSessionsDir?: string;
  transcriptDir?: string;
  agentRoot?: string;
  workspaceFolder?: string;
  sessionId?: string;
  isAgentSession?: boolean;
  quietMs?: number;
}

export interface CompatReport {
  ok: boolean;
  lines: string[];
  problems: string[];
}

/** transcript / agent 事件里“必须有”的事件类型；一个都读不到就说明结构变了 */
const KNOWN_EVENTS = [
  'session.start',
  'user.message',
  'assistant.message',
  'assistant.turn_start',
  'assistant.turn_end',
  'tool.execution_start',
  'tool.execution_complete',
];

const PROBE_BYTES = 256 * 1024;

interface FileInfo {
  file: string;
  mtime: number;
  ageMs: number;
}

const ageText = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 90) {
    return `${sec}s 前`;
  }
  const min = Math.round(sec / 60);
  if (min < 90) {
    return `${min} 分钟前`;
  }
  const hour = Math.round(min / 60);
  if (hour < 48) {
    return `${hour} 小时前`;
  }
  return `${Math.round(hour / 24)} 天前`;
};

function newestIn(dir: string | undefined, depth: number, match: (name: string) => boolean): FileInfo | undefined {
  if (!dir) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth <= 0) {
        continue;
      }
      const nested = newestIn(full, depth - 1, match);
      if (nested && (!best || nested.mtime > best.mtime)) {
        best = { file: nested.file, mtime: nested.mtime };
      }
      continue;
    }
    if (!entry.isFile() || !match(entry.name)) {
      continue;
    }
    try {
      const stat = fs.statSync(full);
      if (!best || stat.mtimeMs > best.mtime) {
        best = { file: full, mtime: stat.mtimeMs };
      }
    } catch {
      /* 忽略 */
    }
  }
  return best ? { ...best, ageMs: Date.now() - best.mtime } : undefined;
}

/** 读文件尾部若干行，统计事件类型（判断 schema 有没有变） */
export function probeEventTypes(file: string, maxLines = 300): { total: number; known: number; types: string[] } {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - PROBE_BYTES);
    const length = Math.min(PROBE_BYTES, stat.size);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim().startsWith('{')).slice(-maxLines);
    let total = 0;
    let known = 0;
    const types = new Set<string>();
    for (const line of lines) {
      let parsed: { type?: unknown };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed.type !== 'string') {
        continue;
      }
      total += 1;
      types.add(parsed.type);
      if (KNOWN_EVENTS.includes(parsed.type)) {
        known += 1;
      }
    }
    return { total, known, types: Array.from(types).slice(0, 12) };
  } catch {
    return { total: 0, known: 0, types: [] };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

function readWorkspaceCwd(agentRoot: string | undefined): { dir: string; cwd: string } | undefined {
  if (!agentRoot) {
    return undefined;
  }
  const newest = newestIn(agentRoot, 1, (name) => name === 'events.jsonl');
  if (!newest) {
    return undefined;
  }
  const dir = path.dirname(newest.file);
  try {
    const yaml = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
    const line = yaml.split('\n').find((item) => /^\s*cwd:/.test(item));
    return { dir, cwd: line ? line.replace(/^\s*cwd:\s*/, '').trim() : '' };
  } catch {
    return { dir, cwd: '' };
  }
}

export function buildCompatReport(input: CompatInput): CompatReport {
  const lines: string[] = [];
  const problems: string[] = [];

  lines.push(
    `版本：VS Code ${input.vscodeVersion || '?'} · 插件 ${input.extensionVersion || '?'} · 内置 Copilot ${
      input.copilotVersion || '未知'
    }`,
  );

  const patchLabel: Record<string, string> = {
    patched: '已打补丁（即时落盘）',
    clean: '未打补丁（建议执行命令打补丁）',
    unsupported: '打包结构已变化，补丁需要适配',
    missing: '没找到内置 Copilot 文件',
  };
  lines.push(`补丁：${patchLabel[input.patchState] || input.patchState}${input.patchFile ? `（${input.patchFile}）` : ''}`);
  if (input.patchState === 'unsupported') {
    problems.push('Copilot 打包结构变化，落盘补丁需要跟随适配');
  }

  // chatSessions
  const sessions = newestIn(input.chatSessionsDir, 0, (name) => name.endsWith('.jsonl'));
  if (!input.chatSessionsDir) {
    lines.push('chatSessions：未找到目录');
    problems.push('找不到 workspaceStorage 的 chatSessions 目录');
  } else if (!sessions) {
    lines.push(`chatSessions：${input.chatSessionsDir} 里没有 .jsonl`);
    problems.push('chatSessions 目录为空，路径假设可能变了');
  } else {
    lines.push(`chatSessions：最新 ${path.basename(sessions.file)}（${ageText(sessions.ageMs)}）`);
  }

  // transcript（经典会话实时源）
  const transcriptFile = newestIn(input.transcriptDir, 0, (name) => name.endsWith('.jsonl'));
  if (input.transcriptDir) {
    if (transcriptFile) {
      const probe = probeEventTypes(transcriptFile.file);
      const unknown = probe.total > 0 && probe.known === 0;
      lines.push(
        `transcript：最新 ${path.basename(transcriptFile.file)}（${ageText(transcriptFile.ageMs)}），` +
          `已知事件 ${probe.known}/${probe.total}${probe.types.length ? `，类型 ${probe.types.slice(0, 6).join(',')}` : ''}`,
      );
      if (unknown) {
        problems.push('transcript 事件结构可能变了（读不到已知事件类型）');
      }
    } else {
      lines.push(`transcript：${input.transcriptDir} 里还没有文件`);
    }
  } else {
    lines.push('transcript：未找到目录');
    problems.push('找不到 transcripts 目录，经典会话可能无法流式');
  }

  // agent 会话（新式会话面板）
  if (input.agentRoot && fs.existsSync(input.agentRoot)) {
    const agent = readWorkspaceCwd(input.agentRoot);
    const agentFile = newestIn(input.agentRoot, 1, (name) => name === 'events.jsonl');
    if (agentFile) {
      const probe = probeEventTypes(agentFile.file);
      const unknown = probe.total > 0 && probe.known === 0;
      const cwdNote = agent?.cwd ? `，cwd=${agent.cwd}` : '，workspace.yaml 缺 cwd';
      lines.push(`agent 会话：最新 ${path.basename(agent?.dir || '')}（${ageText(agentFile.ageMs)}）${cwdNote}`);
      if (unknown) {
        problems.push('agent 会话事件结构可能变了（读不到已知事件类型）');
      }
      if (input.workspaceFolder && agent?.cwd) {
        const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (norm(agent.cwd) !== norm(input.workspaceFolder)) {
          lines.push(`agent 会话：最新一条属于其他项目，当前项目 ${input.workspaceFolder}`);
        }
      }
    } else {
      lines.push('agent 会话：目录存在但还没有 events.jsonl');
    }
  } else {
    lines.push('agent 会话：未启用（~/.copilot/session-state 不存在）');
  }

  if (input.sessionId) {
    lines.push(
      `当前跟随：${input.sessionId.slice(0, 8)}（${input.isAgentSession ? 'agent 会话' : '经典会话'}）` +
        `${typeof input.quietMs === 'number' ? `，静默 ${Math.round(input.quietMs / 1000)}s` : ''}`,
    );
  }

  if (input.patchState === 'clean') {
    lines.push('提示：未打补丁时功能照常，但长工具步骤期间卡片更新会滞后。');
  }
  if (problems.length === 0) {
    lines.push('结论：当前版本组合的各处假设都成立，无需适配。');
  } else {
    lines.push(`结论：有 ${problems.length} 项需要关注 —— ${problems.join('；')}。`);
  }
  return { ok: problems.length === 0, lines, problems };
}
