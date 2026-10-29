#!/usr/bin/env node
/* EWW Bridge 附带脚本：给 VS Code 内置 Copilot 扩展打“即时落盘”补丁
 *
 * 作用：Copilot 的 transcript 是内存缓冲，一批事件要等下一条事件到来才写盘，
 *      后台等待（如长终端命令）时正文可能几十秒都读不到，飞书卡片就会“卡住”。
 *      本补丁让每条事件后立即 flush，EWW 才能真正流式同步。
 *
 * 用法（在 VS Code 的终端里执行）：
 *   node "<插件目录>/scripts/patch-copilot-flush.js"            # 打补丁
 *   node "<插件目录>/scripts/patch-copilot-flush.js" --check    # 只看状态
 *   node "<插件目录>/scripts/patch-copilot-flush.js" --restore  # 还原
 *   node "<插件目录>/scripts/patch-copilot-flush.js" --path "D:\\VS Code\\resources\\app\\extensions\\copilot\\dist\\extension.js"
 *
 * 说明：
 *   - 插件里也有等价命令「EWW Bridge: 给内置 Copilot 打即时落盘补丁」，优先用它；
 *     本脚本用于 VS Code 安装目录需要管理员权限、或没有 Node 常驻环境时手动执行。
 *   - VS Code 升级会覆盖 extension.js，需要重新执行。
 *   - 脚本会先备份为 extension.js.eww-orig，并做语法校验，失败不会写入。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MARK = '_bufferEntryCore';
const DEFINE_ANCHOR = '_bufferEntry(e,n,r){let o=this._activeSessions.get(e);';
const FLUSH_ANCHOR = 'async flush(e){let n=this._activeSessions.get(e);';

function walkForBundle(root, depth, found) {
  if (!root) {
    return;
  }
  const direct = path.join(root, 'resources', 'app', 'extensions', 'copilot', 'dist', 'extension.js');
  try {
    if (fs.existsSync(direct)) {
      found.push(direct);
      return;
    }
    if (depth <= 0) {
      return;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      walkForBundle(path.join(root, entry.name), depth - 1, found);
    }
  } catch {
    /* 权限不足或路径不存在：忽略 */
  }
}

function candidates() {
  const found = [];
  const names = ['Microsoft VS Code', 'Microsoft VS Code Insiders', 'VSCodium'];
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
    'D:\\VS Code',
    'C:\\Program Files\\Microsoft VS Code',
  ].filter(Boolean);
  for (const root of roots) {
    walkForBundle(root, 2, found);
    for (const name of names) {
      walkForBundle(path.join(root, name), 2, found);
    }
  }
  return found;
}

/** 多个版本目录共存时取最新的那个（旧目录可能残留） */
function newest(files) {
  let best;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtime) {
        best = { file, mtime: stat.mtimeMs };
      }
    } catch {
      /* ignore */
    }
  }
  return best && best.file;
}

const args = process.argv.slice(2);
const mode = args.includes('--restore') ? 'restore' : args.includes('--check') ? 'check' : 'patch';
const pathIndex = args.indexOf('--path');
const explicit = pathIndex >= 0 ? args[pathIndex + 1] : undefined;

const target = explicit ? path.resolve(explicit) : newest(candidates());
if (!target || !fs.existsSync(target)) {
  console.error('找不到 Copilot 扩展文件，请用 --path 指定 extension.js');
  console.error('常见位置：<VS Code 安装目录>\\resources\\app\\extensions\\copilot\\dist\\extension.js');
  process.exit(1);
}

const backup = `${target}.eww-orig`;
const code = fs.readFileSync(target, 'utf8');
const patched = code.includes(MARK);

if (mode === 'check') {
  console.log(`file: ${target}`);
  console.log(`patched: ${patched}`);
  console.log(`backup: ${fs.existsSync(backup)}`);
  process.exit(0);
}

if (mode === 'restore') {
  if (!fs.existsSync(backup)) {
    console.error('没有备份，无法还原');
    process.exit(1);
  }
  fs.copyFileSync(backup, target);
  console.log('已还原，重载窗口后生效。');
  process.exit(0);
}

if (patched) {
  console.log('已经是打过补丁的状态，跳过。');
  process.exit(0);
}

if (!code.includes(DEFINE_ANCHOR) || !code.includes(FLUSH_ANCHOR)) {
  console.error('锚点不匹配：当前 VS Code 版本的 Copilot 打包结构已变化，未做修改。');
  process.exit(1);
}

const next = code
  .replace(DEFINE_ANCHOR, `_bufferEntryCore(e,n,r){let o=this._activeSessions.get(e);`)
  .replace(
    FLUSH_ANCHOR,
    `_bufferEntry(e,n,r){this._bufferEntryCore(e,n,r);void this.flush(e).catch(()=>{})}${FLUSH_ANCHOR}`,
  );

const tmp = path.join(os.tmpdir(), `eww-copilot-check-${process.pid}.cjs`);
fs.writeFileSync(tmp, next, 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  fs.rmSync(tmp, { force: true });
  console.error('语法校验失败，未修改：', String(error.stderr || error).slice(0, 400));
  process.exit(1);
}
fs.rmSync(tmp, { force: true });

try {
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(target, backup);
    console.log(`已备份 → ${backup}`);
  }
  fs.writeFileSync(target, next, 'utf8');
} catch (error) {
  console.error(`写入失败：${error.message}`);
  console.error('若 VS Code 装在 Program Files，请用管理员终端重新执行本脚本。');
  process.exit(1);
}

console.log('补丁完成：transcript 每条事件后立即落盘。请重载窗口（Reload Window）生效。');
