/* 给内置 Copilot Chat 扩展打一个"立即落盘"补丁（可选增强，不影响 EWW 主体功能）
 *
 * 背景：transcript 是内存缓冲 + 只在少数时机 flush，导致后台等待时正文要等很久才可见。
 * 补丁把 _bufferEntry 包一层，每条事件后立即 flush，transcript 变成近实时。
 *
 * 用法：
 *   node tools/patch-copilot-flush.js            # 打补丁（自动找 VS Code 安装目录）
 *   node tools/patch-copilot-flush.js --check    # 只检查当前状态
 *   node tools/patch-copilot-flush.js --restore  # 还原
 *   node tools/patch-copilot-flush.js --path "D:\...\extensions\copilot\dist\extension.js"
 *
 * 注意：VS Code 升级会覆盖该文件，需要重新执行本脚本。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MARK = '_bufferEntryCore';

function candidates() {
  const list = [];
  const suffix = path.join('resources', 'app', 'extensions', 'copilot', 'dist', 'extension.js');
  const roots = [
    'd:\\VS Code',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code'),
  ];
  const walk = (dir, depth) => {
    const direct = path.join(dir, suffix);
    if (fs.existsSync(direct)) {
      list.push(direct);
      return;
    }
    if (depth <= 0) return;
    for (const entry of safeReadDir(dir)) {
      walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    walk(root, 3);
  }
  return list;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--restore') ? 'restore' : args.includes('--check') ? 'check' : 'patch';
const pathArgIndex = args.indexOf('--path');
const explicit = pathArgIndex >= 0 ? args[pathArgIndex + 1] : undefined;

const target = explicit || candidates()[0];
if (!target || !fs.existsSync(target)) {
  console.error('找不到 Copilot 扩展文件，请用 --path 指定 extension.js');
  process.exit(1);
}
const original = `${target}.eww-orig`;
const code = fs.readFileSync(target, 'utf8');
const patched = code.includes(MARK);

if (mode === 'check') {
  console.log(`file: ${target}`);
  console.log(`patched: ${patched}`);
  console.log(`backup: ${fs.existsSync(original)}`);
  process.exit(0);
}

if (mode === 'restore') {
  if (!fs.existsSync(original)) {
    console.error('没有备份，无法还原');
    process.exit(1);
  }
  fs.copyFileSync(original, target);
  console.log('已还原');
  process.exit(0);
}

if (patched) {
  console.log('已经是打过补丁的状态，跳过');
  process.exit(0);
}

if (!fs.existsSync(original)) {
  fs.copyFileSync(target, original);
  console.log(`已备份 → ${original}`);
}

const defineAnchor = '_bufferEntry(e,n,r){let o=this._activeSessions.get(e);';
const flushAnchor = 'async flush(e){let n=this._activeSessions.get(e);';
if (!code.includes(defineAnchor) || !code.includes(flushAnchor)) {
  console.error('锚点不匹配（VS Code 版本可能已变化），未修改');
  process.exit(1);
}

let next = code.replace(defineAnchor, `_bufferEntryCore(e,n,r){let o=this._activeSessions.get(e);`);
next = next.replace(
  flushAnchor,
  `_bufferEntry(e,n,r){this._bufferEntryCore(e,n,r);void this.flush(e).catch(()=>{})}${flushAnchor}`,
);

const tmp = path.join(os.tmpdir(), 'copilot-extension-check.cjs');
fs.writeFileSync(tmp, next, 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  fs.rmSync(tmp, { force: true });
  console.error('语法检查失败，未修改：', String(error.stderr || error).slice(0, 400));
  process.exit(1);
}
fs.copyFileSync(tmp, target);
fs.rmSync(tmp, { force: true });
console.log('补丁完成：transcript 每条事件后立即落盘。请重载窗口生效。');
