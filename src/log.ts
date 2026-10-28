import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
const LOG_FILE = path.join(os.homedir(), 'eww-bridge.log');
const FILE_LOG_ENABLED = process.env.EWW_NO_FILE_LOG !== '1';

function appendFile(line: string): void {
  if (!FILE_LOG_ENABLED) {
    return;
  }
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志落盘失败不影响主流程 */
  }
}

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('EWW Bridge');
  }
  return channel;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(message: string, ...args: unknown[]): void {
  const suffix = args.length ? ' ' + args.map(stringify).join(' ') : '';
  const line = `[${new Date().toLocaleTimeString()}] ${message}${suffix}`;
  initLog().appendLine(line);
  appendFile(line);
}

export function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  log(`ERROR ${message}: ${detail}`);
}
