import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';

/**
 * 单写者锁：同一个项目（同一个文件夹）被多个 VS Code 窗口打开时，
 * 只允许一个实例镜像聊天 / 发飞书，否则会把同一张卡片来回覆盖。
 *
 * 锁文件按项目路径分文件（bridge-owner-<scope>.json），不同项目窗口各自持有自己的锁：
 * 每个项目对应各自的聊天会话与飞书目标，互不影响。
 */
const TTL_MS = 15000;
const HEARTBEAT_MS = 5000;

export interface Ownership {
  instanceId: string;
  owner: boolean;
  ownerLabel?: string;
  scope: string;
  dispose(): void;
}

interface LockBody {
  instanceId: string;
  pid: number;
  label: string;
  scope: string;
  updatedAt: number;
}

/** 项目路径 -> 短哈希，用来给锁文件分桶 */
function scopeHash(scope: string): string {
  const text = scope.toLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function acquireOwnership(storageDir: string, label: string, scope = 'default'): Ownership {
  const instanceId = Math.random().toString(36).slice(2, 10);
  const lockFile = path.join(storageDir, `bridge-owner-${scopeHash(scope)}.json`);
  let heartbeat: NodeJS.Timeout | undefined;

  const readLock = (): LockBody | undefined => {
    try {
      const raw = fs.readFileSync(lockFile, 'utf8');
      const parsed = JSON.parse(raw) as LockBody;
      return parsed && typeof parsed.updatedAt === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const pidAlive = (pid: number): boolean => {
    if (!pid || pid === process.pid) {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const writeLock = (): boolean => {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      const body: LockBody = { instanceId, pid: process.pid, label, scope, updatedAt: Date.now() };
      fs.writeFileSync(lockFile, JSON.stringify(body), 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  const existing = readLock();
  const fresh = !!existing && Date.now() - existing.updatedAt < TTL_MS && pidAlive(existing.pid);
  if (existing && existing.instanceId === instanceId) {
    // 理论上不会发生，保险起见直接当 owner
  }
  if (fresh && existing && existing.instanceId !== instanceId) {
    const owned: Ownership = {
      instanceId,
      owner: false,
      ownerLabel: existing.label,
      scope,
      dispose: () => undefined,
    };
    log(`inst: 本项目已由窗口「${existing.label}」接管（pid=${existing.pid}, scope=${scope}）本实例进入被动模式`);
    return owned;
  }

  writeLock();
  heartbeat = setInterval(() => {
    const current = readLock();
    // 自己还是 owner 就续约；被别人抢走（例如对方判定我们已死）则放弃
    if (current && current.instanceId !== instanceId) {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      log(`inst: 锁已被 ${current.label} 接管，停止续约`);
      return;
    }
    writeLock();
  }, HEARTBEAT_MS);
  if (heartbeat.unref) {
    heartbeat.unref();
  }
  log(`inst: 取得写者锁（${label}, pid=${process.pid}, id=${instanceId}, scope=${scope}）`);

  return {
    instanceId,
    owner: true,
    scope,
    dispose: () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      const current = readLock();
      if (current && current.instanceId === instanceId) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* 文件可能已被清理 */
        }
      }
    },
  };
}
