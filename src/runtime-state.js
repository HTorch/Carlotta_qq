import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';

const BOT_RUNTIME_LOCK_FILENAME = 'bot-runtime.lock.json';
const DEFAULT_RUNTIME_STALE_AFTER_MS = 15_000;
const DEFAULT_RUNTIME_HEARTBEAT_MS = 5_000;

export class BotRuntimeBusyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BotRuntimeBusyError';
    this.details = details;
  }
}

function isErrnoCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function getRuntimeLockPath(rootDir) {
  return path.join(rootDir, 'run', BOT_RUNTIME_LOCK_FILENAME);
}

async function readRuntimeLock(lockPath) {
  try {
    const [contents, stats] = await Promise.all([
      fs.readFile(lockPath, 'utf8'),
      fs.stat(lockPath),
    ]);

    let metadata = null;
    try {
      metadata = JSON.parse(contents);
    } catch {
      metadata = null;
    }

    return { metadata, stats };
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
}

function isRuntimeFresh(stats, staleAfterMs) {
  return Date.now() - stats.mtimeMs <= staleAfterMs;
}

export async function claimBotRuntime({
  rootDir,
  owner,
  staleAfterMs = DEFAULT_RUNTIME_STALE_AFTER_MS,
  heartbeatIntervalMs = DEFAULT_RUNTIME_HEARTBEAT_MS,
}) {
  const lockPath = getRuntimeLockPath(rootDir);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      const startedAt = new Date().toISOString();
      const metadata = {
        owner,
        pid: process.pid,
        startedAt,
        updatedAt: startedAt,
      };

      try {
        await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
      } finally {
        await handle.close();
      }

      let released = false;
      const touch = async () => {
        if (released) {
          return;
        }

        const now = new Date();
        await fs.utimes(lockPath, now, now);
      };

      const heartbeat = setInterval(() => {
        void touch().catch(() => {});
      }, heartbeatIntervalMs);
      heartbeat.unref?.();

      const release = async () => {
        if (released) {
          return;
        }

        released = true;
        clearInterval(heartbeat);
        await fs.rm(lockPath, { force: true });
      };

      const releaseSync = () => {
        if (released) {
          return;
        }

        released = true;
        clearInterval(heartbeat);
        try {
          rmSync(lockPath, { force: true });
        } catch {
        }
      };

      return {
        lockPath,
        metadata,
        release,
        releaseSync,
        touch,
      };
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) {
        throw error;
      }

      const current = await readRuntimeLock(lockPath);
      if (current !== null && isRuntimeFresh(current.stats, staleAfterMs)) {
        const currentOwner = typeof current.metadata?.owner === 'string' ? current.metadata.owner : 'unknown';
        const currentPid = typeof current.metadata?.pid === 'number' ? current.metadata.pid : null;
        const ageMs = Date.now() - current.stats.mtimeMs;

        throw new BotRuntimeBusyError(`Another bot runtime is already active (${currentOwner}${currentPid === null ? '' : `, pid ${currentPid}`}).`, {
          ageMs,
          currentOwner,
          currentPid,
          lockPath,
        });
      }

      await fs.rm(lockPath, { force: true });
    }
  }
}
