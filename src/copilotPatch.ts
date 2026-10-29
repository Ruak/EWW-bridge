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
const MARK = '_bufferEntryCore';
const DEFINE_ANCHOR = '_bufferEntry(e,n,r){let o=this._activeSessions.get(e);';
const FLUSH_ANCHOR = 'async flush(e){let n=this._activeSessions.get(e);';

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
    const state: CopilotPatchState = code.includes(MARK)
      ? 'patched'
      : code.includes(DEFINE_ANCHOR) && code.includes(FLUSH_ANCHOR)
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
  if (code.includes(MARK)) {
    return { ok: true, alreadyPatched: true, file, message: '已经打过补丁，无需重复。' };
  }
  if (!code.includes(DEFINE_ANCHOR) || !code.includes(FLUSH_ANCHOR)) {
    return {
      ok: false,
      file,
      message: '当前 VS Code 版本的 Copilot 打包代码结构已变化（锚点不匹配），未做任何修改。',
    };
  }
  const next = code
    .replace(DEFINE_ANCHOR, `_bufferEntryCore(e,n,r){let o=this._activeSessions.get(e);`)
    .replace(
      FLUSH_ANCHOR,
      `_bufferEntry(e,n,r){this._bufferEntryCore(e,n,r);void this.flush(e).catch(()=>{})}${FLUSH_ANCHOR}`,
    );
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
