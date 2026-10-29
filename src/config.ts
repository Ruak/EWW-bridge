import * as vscode from 'vscode';

export interface BridgeConfig {
  enabled: boolean;
  appId: string;
  defaultChatId: string;
  forwardUser: boolean;
  forwardAssistant: boolean;
  forwardTools: boolean;
  forwardProgress: boolean;
  forwardThinking: boolean;
  forwardStreaming: boolean;
  /** 是否允许从 chatSessions 补丁流抽取正文（实验能力，默认关闭：可能串入别的段落） */
  patchStreamText: boolean;
  streamingIntervalMs: number;
  idleMs: number;
  allowedOpenIds: string[];
  prefix: string;
  newChat: boolean;
  injectTimeoutMs: number;
}

export const SECRET_APP_SECRET = 'ewwBridge.feishu.appSecret';
export const STATE_LAST_CHAT_ID = 'ewwBridge.lastChatId';

export function readConfig(): BridgeConfig {
  const c = vscode.workspace.getConfiguration('ewwBridge');
  return {
    enabled: c.get<boolean>('enabled', true),
    appId: (c.get<string>('feishu.appId', '') || '').trim(),
    defaultChatId: (c.get<string>('feishu.defaultChatId', '') || '').trim(),
    forwardUser: c.get<boolean>('forward.userMessages', true),
    forwardAssistant: c.get<boolean>('forward.assistantMessages', true),
    forwardTools: c.get<boolean>('forward.toolCalls', false),
    forwardProgress: c.get<boolean>('forward.progress', true),
    forwardThinking: c.get<boolean>('forward.thinking', true),
    forwardStreaming: c.get<boolean>('forward.streaming', true),
    patchStreamText: c.get<boolean>('forward.patchStreamText', true),
    streamingIntervalMs: Math.max(300, c.get<number>('forward.streamingIntervalMs', 500)),
    idleMs: Math.max(500, c.get<number>('forward.idleMs', 2500)),
    allowedOpenIds: (c.get<string[]>('security.allowedOpenIds', []) || []).map((s) => s.trim()).filter(Boolean),
    prefix: (c.get<string>('security.prefix', '') || '').trim(),
    newChat: c.get<boolean>('inject.newChat', false),
    injectTimeoutMs: Math.max(5000, c.get<number>('inject.timeoutMs', 900000)),
  };
}

export async function getAppSecret(context: vscode.ExtensionContext): Promise<string | undefined> {
  const secret = await context.secrets.get(SECRET_APP_SECRET);
  return secret && secret.trim() ? secret.trim() : undefined;
}

export async function storeAppSecret(context: vscode.ExtensionContext, secret: string): Promise<void> {
  await context.secrets.store(SECRET_APP_SECRET, secret.trim());
}

export async function updateSetting<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration('ewwBridge').update(key, value, vscode.ConfigurationTarget.Workspace);
}
