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

// 锚点用正则：VS Code 升级后压缩器变量名（e/n/r/o）可能变，但方法名与结构不变
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

const wrapperFor = (a, b, c) =>
  `_bufferEntry(${a},${b},${c}){this._bufferEntryCore(${a},${b},${c});` + `void this.flush(${a}).catch(()=>{})}`;

function isPatched(code) {
  return PATCHED_RE.test(code);
}

/** 生成补丁源码；返回 { ok, code, reason } */
function buildPatchedCode(code) {
  if (isPatched(code)) {
    return { ok: false, reason: 'already' };
  }
  // 旧版补丁只改了名、包装方法插错到别的类：就地补一个，不用还原重来
  const core = CORE_RE.exec(code);
  if (core) {
    const wrapper = wrapperFor(core[1], core[2], core[3]);
    return { ok: true, code: code.slice(0, core.index) + wrapper + code.slice(core.index) };
  }
  const define = DEFINE_RE.exec(code);
  if (!define) {
    return { ok: false, reason: 'define-anchor' };
  }
  // 包装方法必须紧贴改名后的定义插入：bundle 里别的类（新版 ChatDebugFileLogger）也有同形态的
  // async flush，早先按 flush 定位会把包装插到那个类里，本类丢了 _bufferEntry →
  // Copilot 每次发消息都报 "this._bufferEntry is not a function"，整个对话请求失败。
  const [, a, b, c] = define;
  const coreText = define[0].replace('_bufferEntry(', '_bufferEntryCore(');
  return {
    ok: true,
    code: code.slice(0, define.index) + wrapperFor(a, b, c) + coreText + code.slice(define.index + define[0].length),
  };
}

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
let code = fs.readFileSync(target, 'utf8');
const patched = isPatched(code);

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

const built = buildPatchedCode(code);
if (!built.ok) {
  console.error(`锚点不匹配（${built.reason}）：当前 VS Code / Copilot 的打包结构可能已变化，未做修改。`);
  console.error('请到插件仓库反馈，或等待插件更新；期间功能照常。');
  process.exit(1);
}
code = built.code;

const next = code;

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
