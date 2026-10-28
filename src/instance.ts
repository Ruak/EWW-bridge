import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';

/**
 * 单写者锁：同一台机器上多个 VS Code 窗口都装了本扩展时，
 * 只允许一个实例镜像聊天 / 发飞书，否则会把同一张卡片来回覆盖。
 *
 * 锁文件放在扩展的 globalStorage 下（跨窗口共享），带 pid 与心跳。
 */
const TTL_MS = 15000;
const HEARTBEAT_MS = 5000;

export interface Ownership {
  instanceId: string;
  owner: boolean;
  ownerLabel?: string;
  dispose(): void;
}

interface LockBody {
  instanceId: string;
  pid: number;
  label: string;
  updatedAt: number;
}

export function acquireOwnership(storageDir: string, label: string): Ownership {
  const instanceId = Math.random().toString(36).slice(2, 10);
  const lockFile = path.join(storageDir, 'bridge-owner.json');
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
      const body: LockBody = { instanceId, pid: process.pid, label, updatedAt: Date.now() };
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
      dispose: () => undefined,
    };
    log(`inst: 另一个窗口已接管（${existing.label}, pid=${existing.pid}）本实例进入只读模式`);
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
  log(`inst: 取得写者锁（${label}, pid=${process.pid}, id=${instanceId}）`);

  return {
    instanceId,
    owner: true,
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
