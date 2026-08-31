import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BotRuntimeBusyError, claimBotRuntime } from './runtime-state.js';

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'carlotta-runtime-'));
}

test('claimBotRuntime creates a lock, refreshes it, and releases it', async () => {
  const rootDir = await makeTempRoot();
  const runtime = await claimBotRuntime({
    rootDir,
    owner: 'linux',
    staleAfterMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });

  const lockPath = runtime.lockPath;
  const firstStat = await fs.stat(lockPath);
  await runtime.touch();
  const secondStat = await fs.stat(lockPath);

  assert.ok(secondStat.mtimeMs >= firstStat.mtimeMs);

  await runtime.release();
  await assert.rejects(fs.stat(lockPath));
});

test('claimBotRuntime rejects while a fresh lock is active', async () => {
  const rootDir = await makeTempRoot();
  const runtime = await claimBotRuntime({
    rootDir,
    owner: 'windows',
    staleAfterMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });

  await assert.rejects(
    claimBotRuntime({
      rootDir,
      owner: 'linux',
      staleAfterMs: 60_000,
      heartbeatIntervalMs: 60_000,
    }),
    BotRuntimeBusyError,
  );

  await runtime.release();
});

test('claimBotRuntime reclaims a stale lock', async () => {
  const rootDir = await makeTempRoot();
  const runDir = path.join(rootDir, 'run');
  const lockPath = path.join(runDir, 'bot-runtime.lock.json');

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ owner: 'windows', pid: 1234, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const staleTimestamp = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, staleTimestamp, staleTimestamp);

  const runtime = await claimBotRuntime({
    rootDir,
    owner: 'linux',
    staleAfterMs: 1_000,
    heartbeatIntervalMs: 60_000,
  });

  const contents = await fs.readFile(lockPath, 'utf8');
  assert.match(contents, /"owner": "linux"/);

  await runtime.release();
});
