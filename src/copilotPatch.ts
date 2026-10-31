import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { log } from './log';

/**
 * 给 VS Code 内置 Copilot 扩展打“即时落盘”补丁。
 *
 * 背景：Copilot 的 transcript 是内存缓冲，只在一批事件的“下一条事件”到来时才 flush，
 * 后台等待（如终端命令）时正文可能几十秒都读不到。补丁把 `_bufferEntry` 包一层，
 * 每条事件后立刻 flush → transcript 近实时，EWW 的卡片才能真正流式。
 *
 * 说明：VS Code 升级会覆盖 extension.js，需要重打；本模块与随插件发布的
 * `scripts/patch-copilot-flush.js` 使用同一套锚点。
 */
// 锚点用正则而不是固定字符串：VS Code 升级后压缩器的变量名（e/n/r/o）可能变，但方法名与结构不变
const DEFINE_RE =
  /_bufferEntry\(\s*([\w$]+)\s*,\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\{let\s+([\w$]+)\s*=\s*this\._activeSessions\.get\(\s*\1\s*\)/;
const CORE_RE =
  /_bufferEntryCore\(\s*([\w$]+)\s*,\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\{let\s+([\w$]+)\s*=\s*this\._activeSessions\.get\(\s*\1\s*\)/;
// 已打补丁的标志：包装方法紧贴在 core 定义之前（同一类里），且参数名一致
const PATCHED_RE = new RegExp(
  '_bufferEntry\\(\\s*([\\w$]+)\\s*,\\s*([\\w$]+)\\s*,\\s*([\\w$]+)\\s*\\)\\s*\\{\\s*' +
    'this\\._bufferEntryCore\\(\\s*\\1\\s*,\\s*\\2\\s*,\\s*\\3\\s*\\);\\s*' +
    'void\\s+this\\.flush\\(\\s*\\1\\s*\\)\\.catch\\(\\(\\)=>\\{\\}\\)\\s*\\}' +
    '_bufferEntryCore\\(',
);

const wrapperFor = (a: string, b: string, c: string): string =>
  `_bufferEntry(${a},${b},${c}){this._bufferEntryCore(${a},${b},${c});` + `void this.flush(${a}).catch(()=>{})}`;

export function isCopilotPatched(code: string): boolean {
  return PATCHED_RE.test(code);
}

/**
 * 生成打过补丁的 bundle 源码（纯函数，便于单测）。
 * 做两件事：`_bufferEntry` 改名 `_bufferEntryCore`，再插入一个同名包装方法，每条事件后立即 flush。
 *
 * 包装方法必须紧贴改名后的定义插入：bundle 里还有别的类（新版 ChatDebugFileLogger）也定义了同形态的
 * `async flush`，早先按 flush 定位会把包装插到那个类里，本类的 `_bufferEntry` 就此消失，
 * Copilot 每次发消息都报 "this._bufferEntry is not a function"，整个对话请求失败。
 */
export function buildPatchedCode(code: string): { ok: boolean; code?: string; reason?: string } {
  if (isCopilotPatched(code)) {
    return { ok: false, reason: 'already' };
  }
  // 旧版补丁只改了名、包装方法插错到别的类：就地补一个，不用还原重来
  const core = CORE_RE.exec(code);
  if (core && core.index !== undefined) {
    const wrapper = wrapperFor(core[1], core[2], core[3]);
    return { ok: true, code: code.slice(0, core.index) + wrapper + code.slice(core.index) };
  }
  const define = DEFINE_RE.exec(code);
  if (!define || define.index === undefined) {
    return { ok: false, reason: 'define-anchor' };
  }
  const [, a, b, c] = define;
  const coreText = define[0].replace('_bufferEntry(', '_bufferEntryCore(');
  const next =
    code.slice(0, define.index) +
    wrapperFor(a, b, c) +
    coreText +
    code.slice(define.index + define[0].length);
  return { ok: true, code: next };
}


export type CopilotPatchState = 'patched' | 'clean' | 'unsupported' | 'missing';

export interface CopilotPatchStatus {
  state: CopilotPatchState;
  file?: string;
  backup: boolean;
}

export interface CopilotPatchOutcome {
  ok: boolean;
  alreadyPatched?: boolean;
  file?: string;
  message: string;
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const INSTALL_DIRS = ['Microsoft VS Code', 'Microsoft VS Code Insiders', 'VSCodium'];

/** 在安装根目录下有限深度地找 resources/app/extensions/copilot/dist/extension.js（新版可能带 <hash> 子目录） */
function walkForBundle(root: string, depth: number, found: string[]): void {
  if (!root) {
    return;
  }
  const direct = path.join(root, 'resources', 'app', 'extensions', 'copilot', 'dist', 'extension.js');
  if (fs.existsSync(direct)) {
    found.push(direct);
    return;
  }
  if (depth <= 0) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    walkForBundle(path.join(root, entry.name), depth - 1, found);
  }
}

const newest = (files: string[]): string | undefined => {
  let best: { file: string; mtime: number } | undefined;
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtime) {
        best = { file, mtime: stat.mtimeMs };
      }
    } catch {
      /* 忽略不可读项 */
    }
  }
  return best?.file;
};

/** 定位内置 Copilot 的 extension.js（多个候选，取最新的一个） */
export function copilotExtensionFile(): string | undefined {
  const candidates: string[] = [];
  const config = vscode.workspace?.getConfiguration?.('ewwBridge');
  const configured = ((config?.get<string>('copilotExtensionFile') as string) || '').trim();
  if (configured) {
    candidates.push(configured);
  }
  // 内置扩展：GitHub.copilot 的 extensionPath 就是 <app>/extensions/copilot
  for (const id of ['GitHub.copilot', 'GitHub.copilot-chat']) {
    const ext = vscode.extensions?.getExtension?.(id);
    if (ext?.extensionPath) {
      candidates.push(path.join(ext.extensionPath, 'dist', 'extension.js'));
      candidates.push(path.join(ext.extensionPath, 'extension.js'));
    }
  }
  const appRoot = vscode.env?.appRoot || '';
  if (appRoot) {
    candidates.push(path.join(appRoot, 'extensions', 'copilot', 'dist', 'extension.js'));
  }
  // 安装目录可能带 <hash> 版本子目录（如 D:\VS Code\Microsoft VS Code\e646868227\resources\app\...）
  const roots = [
    path.dirname(process.execPath),
    appRoot ? path.dirname(appRoot) : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
  ];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    walkForBundle(root, 2, candidates);
    for (const name of INSTALL_DIRS) {
      walkForBundle(path.join(root, name), 2, candidates);
    }
  }
  return newest(candidates);
}

export function copilotPatchStatus(): CopilotPatchStatus {
  const file = copilotExtensionFile();
  if (!file) {
    return { state: 'missing', backup: false };
  }
  try {
    const code = fs.readFileSync(file, 'utf8');
    const state: CopilotPatchState = isCopilotPatched(code)
      ? 'patched'
      : DEFINE_RE.test(code) || CORE_RE.test(code)
        ? 'clean'
        : 'unsupported';
    return { state, file, backup: fs.existsSync(`${file}.eww-orig`) };
  } catch (error) {
    log(`copilot patch: 读取失败 ${errText(error)}`);
    return { state: 'missing', file, backup: false };
  }
}

export function applyCopilotPatch(): CopilotPatchOutcome {
  const file = copilotExtensionFile();
  if (!file) {
    return {
      ok: false,
      message:
        '没找到 VS Code 内置 Copilot 扩展文件。可在设置 ewwBridge.copilotExtensionFile 里手动指定，或直接运行插件目录下的 scripts/patch-copilot-flush.js --path <extension.js>。',
    };
  }
  let code: string;
  try {
    code = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, file, message: `读取失败：${errText(error)}` };
  }
  if (isCopilotPatched(code)) {
    return { ok: true, alreadyPatched: true, file, message: '已经打过补丁，无需重复。' };
  }
  const built = buildPatchedCode(code);
  if (!built.ok || !built.code) {
    return {
      ok: false,
      file,
      message:
        `当前 VS Code / Copilot 版本的打包代码结构已变化（${built.reason || 'anchor'}），未做任何修改。` +
        '请执行「EWW Bridge: 兼容性自检」并反馈日志，或等待插件更新；期间功能照常，只是长任务时卡片更新会滞后。',
    };
  }
  const next = built.code;
  try {
    // 语法校验：坏补丁会让 Copilot 整个起不来，必须先确认能解析
    new vm.Script(next, { filename: file });
  } catch (error) {
    return { ok: false, file, message: `补丁语法校验失败，未修改：${errText(error)}` };
  }
  const backup = `${file}.eww-orig`;
  try {
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
    }
    fs.writeFileSync(file, next, 'utf8');
  } catch (error) {
    return {
      ok: false,
      file,
      message:
        `写入失败：${errText(error)}。VS Code 装在 Program Files 时需要管理员权限：` +
        '以管理员身份启动一次 VS Code 再执行本命令，或在该目录用管理员终端运行 scripts/patch-copilot-flush.js。',
    };
  }
  log(`copilot patch: 已写入 ${file}`);
  return { ok: true, file, message: '已打补丁：Copilot 事件即时落盘。需要重载窗口生效。' };
}

export function restoreCopilotPatch(): CopilotPatchOutcome {
  const file = copilotExtensionFile();
  if (!file) {
    return { ok: false, message: '没找到 VS Code 内置 Copilot 扩展文件。' };
  }
  const backup = `${file}.eww-orig`;
  if (!fs.existsSync(backup)) {
    return { ok: false, file, message: '没有备份文件，无法还原（重装 VS Code 即可恢复原状）。' };
  }
  try {
    fs.copyFileSync(backup, file);
  } catch (error) {
    return { ok: false, file, message: `还原失败：${errText(error)}` };
  }
  log(`copilot patch: 已还原 ${file}`);
  return { ok: true, file, message: '已还原为原始文件，重载窗口后恢复默认落盘节奏。' };
}

/** 随插件发布的独立脚本（没有 Node 环境也能看到路径，方便复制到终端执行） */
export function patchScriptPath(): string {
  return path.join(__dirname, '..', 'scripts', 'patch-copilot-flush.js');
}
