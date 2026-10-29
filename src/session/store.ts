import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { log } from '../log';
import { SessionWatcher } from './watcher';
import { TranscriptSource, TranscriptWatcher } from './transcript';

export interface SessionPaths {
  chatSessionsDir?: string;
  transcriptsDir?: string;
  storageRoot?: string;
}

/**
 * workspaceStorage/<hash>/chatSessions  — 当前工作区的会话；
 * globalStorage/emptyWindowChatSessions — 空窗口会话（未打开文件夹时）。
 */
export function resolveSessionPaths(context: vscode.ExtensionContext): SessionPaths {
  if (context.storageUri) {
    // storageUri = <workspaceStorage>/<hash>/<extensionId>
    const hashDir = path.dirname(context.storageUri.fsPath);
    return {
      storageRoot: hashDir,
      chatSessionsDir: path.join(hashDir, 'chatSessions'),
      transcriptsDir: path.join(hashDir, 'GitHub.copilot-chat', 'transcripts'),
    };
  }
  const globalStorage = context.globalStorageUri.fsPath;
  const userData = path.dirname(globalStorage); // .../User/globalStorage
  return {
    storageRoot: path.join(userData, 'emptyWindowChatSessions'),
    chatSessionsDir: path.join(userData, 'emptyWindowChatSessions'),
  };
}

export function createWatcher(context: vscode.ExtensionContext): SessionWatcher | undefined {
  const paths = resolveSessionPaths(context);
  if (!paths.chatSessionsDir) {
    log('watcher: 未找到会话目录，桥接将只支持入站指令');
    return undefined;
  }
  log(`watcher: 会话目录 ${paths.chatSessionsDir}`);
  return new SessionWatcher(paths.chatSessionsDir, 300);
}

export function createTranscriptWatcher(context: vscode.ExtensionContext): TranscriptWatcher | undefined {
  const paths = resolveSessionPaths(context);
  const sources: TranscriptSource[] = [];
  if (paths.transcriptsDir) {
    sources.push({ dir: paths.transcriptsDir, layout: 'flat' });
  }
  // Copilot agent 会话（右侧「会话」面板里的新式对话）：事件格式与 transcript 一致，且实时落盘
  const agentRoot = path.join(os.homedir(), '.copilot', 'session-state');
  if (fs.existsSync(agentRoot)) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    sources.push({ dir: agentRoot, layout: 'session-state', workspaceFolder: folder });
    log(`transcript: 已加入 agent 会话源 ${agentRoot}${folder ? `（项目 ${folder}）` : ''}`);
  }
  if (sources.length === 0) {
    return undefined;
  }
  log(`transcript: 目录 ${sources.map((s) => s.dir).join(' | ')}`);
  return new TranscriptWatcher(sources, 200);
}
