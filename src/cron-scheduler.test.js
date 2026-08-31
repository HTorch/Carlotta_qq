import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CronScheduler } from './cron-scheduler.js';

const NOW = Date.parse('2026-08-15T10:50:45.000Z');

async function withScheduler(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'carlotta-cron-'));
  const filePath = path.join(directory, 'cron-reminders.json');
  try {
    await run({ directory, filePath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('CronScheduler persists a parsed broadcast task atomically', async () => {
  await withScheduler(async ({ filePath }) => {
    const scheduler = new CronScheduler({
      filePath,
      now: () => NOW,
      createTaskId: () => 'cron-1',
    });
    await scheduler.initialize();

    const result = await scheduler.create({
      groupId: '1',
      creatorUserId: '2',
      commandText: 'every 1m times 10 broadcast | 记得吃饭',
    });

    assert.deepEqual(result, { kind: 'created', id: 'cron-1', firstRunText: '2026-08-15 18:50' });
    assert.deepEqual(scheduler.getSnapshot(), [{
      id: 'cron-1',
      groupId: '1',
      creatorUserId: '2',
      content: ' 记得吃饭',
      firstRunAt: NOW - 45_000,
      intervalMs: 60_000,
      expiresAt: null,
      maxRuns: 10,
      runCount: 0,
      notifyCreator: false,
      nextRunAt: NOW - 45_000,
      retryCount: 0,
      retryAt: null,
      status: 'active',
    }]);
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.deepEqual(stored.tasks, scheduler.getSnapshot());
  });
});

test('CronScheduler rejects ordinary creator capacity and enforces cancellation permission', async () => {
  await withScheduler(async ({ filePath }) => {
    let nextId = 0;
    const scheduler = new CronScheduler({
      filePath,
      now: () => NOW,
      createTaskId: () => `cron-${++nextId}`,
    });
    await scheduler.initialize();

    for (let index = 0; index < 10; index += 1) {
      const result = await scheduler.create({ groupId: '1', creatorUserId: '2', commandText: `2026081519${String(index).padStart(2, '0')} | task` });
      assert.equal(result.kind, 'created');
    }

    const overLimit = await scheduler.create({ groupId: '1', creatorUserId: '2', commandText: '202608152000 | task' });
    assert.equal(overLimit.kind, 'rejected');
    const forbidden = await scheduler.cancel({ groupId: '1', requesterUserId: '3', taskId: 'cron-1' });
    assert.equal(forbidden.kind, 'rejected');
    const cancelled = await scheduler.cancel({ groupId: '1', requesterUserId: '100001', taskId: 'cron-1' });
    assert.deepEqual(cancelled, { kind: 'cancelled', id: 'cron-1' });
  });
});

test('CronScheduler keeps last-known-good tasks on malformed reload and skips missed runs on startup', async () => {
  await withScheduler(async ({ filePath }) => {
    await fs.writeFile(filePath, JSON.stringify({ tasks: [
      {
        id: 'repeat', groupId: '1', creatorUserId: '2', content: 'repeat', firstRunAt: NOW - 300_000,
        intervalMs: 60_000, expiresAt: null, maxRuns: 10, runCount: 0, notifyCreator: true,
        nextRunAt: NOW - 120_000, retryCount: 0, retryAt: null, status: 'active',
      },
      {
        id: 'once', groupId: '1', creatorUserId: '2', content: 'once', firstRunAt: NOW - 120_000,
        intervalMs: null, expiresAt: null, maxRuns: null, runCount: 0, notifyCreator: true,
        nextRunAt: NOW - 120_000, retryCount: 0, retryAt: null, status: 'active',
      },
    ] }), 'utf8');
    const scheduler = new CronScheduler({ filePath, now: () => NOW, createTaskId: () => 'unused' });
    await scheduler.initialize();

    assert.deepEqual(scheduler.getSnapshot().map((task) => [task.id, task.nextRunAt]), [['repeat', NOW + 60_000]]);
    await fs.writeFile(filePath, '{ invalid', 'utf8');
    const result = await scheduler.reloadFromDisk();
    assert.equal(result.ok, false);
    assert.equal(scheduler.getSnapshot()[0]?.id, 'repeat');
  });
});

test('CronScheduler delivers default mentions, broadcast text, and retries failures', async () => {
  await withScheduler(async ({ filePath }) => {
    let now = NOW - 45_000;
    let nextId = 0;
    const calls = [];
    const apiClient = {
      async sendGroupMessage(groupId, message) {
        calls.push({ groupId, message });
        if (message !== ' broadcast' && calls.filter((call) => call.message !== ' broadcast').length <= 3) {
          throw new Error('offline');
        }
      },
    };
    const scheduler = new CronScheduler({
      filePath,
      now: () => now,
      createTaskId: () => `cron-${++nextId}`,
      apiClient,
      setTimer: () => ({ unref() {} }),
      clearTimer() {},
    });
    await scheduler.initialize();
    await scheduler.create({ groupId: '1', creatorUserId: '2', commandText: '202608151850 | mention' });
    await scheduler.create({ groupId: '1', creatorUserId: '2', commandText: '202608151850 broadcast | broadcast' });

    await scheduler.processDue();
    assert.deepEqual(calls[0], {
      groupId: '1',
      message: [{ type: 'at', data: { qq: '2' } }, { type: 'text', data: { text: ' mention' } }],
    });
    assert.deepEqual(calls[1], { groupId: '1', message: ' broadcast' });

    now += 60_000;
    await scheduler.processDue();
    now += 60_000;
    await scheduler.processDue();
    assert.deepEqual(calls.at(-1), {
      groupId: '1',
      message: [{ type: 'at', data: { qq: '2' } }, { type: 'text', data: { text: 'cron失败' } }],
    });
    assert.equal(scheduler.getSnapshot().length, 0);
  });
});
