import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { formatBeijingMinute, getFirstFutureRun, parseCronSchedule } from './cron-schedule.js';

// allow: SIZE_OK — one persistent scheduler state machine owns task transitions and its single timer.
const ADMIN_USER_ID = '100001';
const MAX_CREATOR_TASKS = 10;

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('cron task must be an object');
  }

  const task = {
    id: String(value.id ?? ''),
    groupId: String(value.groupId ?? ''),
    creatorUserId: String(value.creatorUserId ?? ''),
    content: value.content,
    firstRunAt: value.firstRunAt,
    intervalMs: value.intervalMs,
    expiresAt: value.expiresAt,
    maxRuns: value.maxRuns,
    runCount: value.runCount,
    notifyCreator: value.notifyCreator,
    nextRunAt: value.nextRunAt,
    retryCount: value.retryCount,
    retryAt: value.retryAt ?? null,
    status: value.status,
  };

  if (!task.id || !task.groupId || !task.creatorUserId || typeof task.content !== 'string' || !task.content.trim()
    || !Number.isFinite(task.firstRunAt) || !Number.isFinite(task.nextRunAt)
    || (task.intervalMs !== null && !isPositiveInteger(task.intervalMs))
    || (task.expiresAt !== null && !Number.isFinite(task.expiresAt))
    || (task.maxRuns !== null && !isPositiveInteger(task.maxRuns))
    || !Number.isSafeInteger(task.runCount) || task.runCount < 0
    || typeof task.notifyCreator !== 'boolean' || !Number.isSafeInteger(task.retryCount) || task.retryCount < 0
    || (task.retryAt !== null && !Number.isFinite(task.retryAt))
    || task.status !== 'active') {
    throw new Error(`invalid cron task: ${task.id || 'unknown'}`);
  }

  return task;
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tasks)) {
    throw new Error('cron reminder config must contain tasks');
  }

  const tasks = value.tasks.map(normalizeTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error('cron reminder ids must be unique');
  }
  return tasks;
}

export class CronScheduler {
  constructor({ filePath, now = () => Date.now(), createTaskId = randomUUID, apiClient = null, runtimeControl = { isEnabled: () => true }, setTimer = setTimeout, clearTimer = clearTimeout, logger = null }) {
    this.filePath = filePath;
    this.now = now;
    this.createTaskId = createTaskId;
    this.apiClient = apiClient;
    this.runtimeControl = runtimeControl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.tasks = new Map();
    this.writeQueue = Promise.resolve();
    this.timer = null;
    this.processing = false;
  }

  getSnapshot() {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  replaceSnapshot(tasks) {
    this.tasks = new Map(tasks.map((task) => [task.id, task]));
  }

  async initialize() {
    const result = await this.reloadFromDisk();
    if (result.ok) {
      await this.recoverMissedRuns();
      this.scheduleNext();
    }
    return result;
  }

  async reloadFromDisk() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.replaceSnapshot(normalizeSnapshot(JSON.parse(content)));
      return { ok: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.replaceSnapshot([]);
        return { ok: true };
      }
      return { ok: false, error };
    }
  }

  async create({ groupId, creatorUserId, commandText }) {
    const parsed = parseCronSchedule(commandText, { now: this.now() });
    if (parsed.kind === 'rejected') {
      return parsed;
    }

    return this.enqueue(async () => {
      const creator = String(creatorUserId);
      const group = String(groupId);
      const activeCount = [...this.tasks.values()].filter((task) => task.groupId === group && task.creatorUserId === creator).length;
      if (creator !== ADMIN_USER_ID && activeCount >= MAX_CREATOR_TASKS) {
        return { kind: 'rejected', message: '每个群最多保留 10 个活动 cron 任务' };
      }

      const id = String(this.createTaskId());
      if (this.tasks.has(id)) {
        throw new Error(`duplicate cron task id: ${id}`);
      }

      const task = {
        id,
        groupId: group,
        creatorUserId: creator,
        content: parsed.schedule.content,
        firstRunAt: parsed.schedule.firstRunAt,
        intervalMs: parsed.schedule.intervalMs,
        expiresAt: parsed.schedule.expiresAt,
        maxRuns: parsed.schedule.maxRuns,
        runCount: 0,
        notifyCreator: parsed.schedule.notifyCreator,
        nextRunAt: parsed.schedule.firstRunAt,
        retryCount: 0,
        retryAt: null,
        status: 'active',
      };
      const next = [...this.tasks.values(), task];
      await this.persistSnapshot(next);
      this.replaceSnapshot(next);
      this.scheduleNext();
      return { kind: 'created', id, firstRunText: formatBeijingMinute(task.firstRunAt) };
    });
  }

  async cancel({ groupId, requesterUserId, taskId }) {
    return this.enqueue(async () => {
      const task = this.tasks.get(String(taskId));
      if (!task || task.groupId !== String(groupId)) {
        return { kind: 'rejected', message: '未找到 cron 任务' };
      }
      if (String(requesterUserId) !== ADMIN_USER_ID && task.creatorUserId !== String(requesterUserId)) {
        return { kind: 'rejected', message: '只有创建者或全局管理员可以取消 cron 任务' };
      }

      const next = [...this.tasks.values()].filter((item) => item.id !== task.id);
      await this.persistSnapshot(next);
      this.replaceSnapshot(next);
      this.scheduleNext();
      return { kind: 'cancelled', id: task.id };
    });
  }

  async recoverMissedRuns() {
    return this.enqueue(async () => {
      const now = this.now();
      let changed = false;
      const next = [];
      for (const task of this.tasks.values()) {
        if (task.retryAt !== null) {
          next.push(task);
          continue;
        }
        if (task.intervalMs === null) {
          if (task.nextRunAt > now) next.push(task);
          else changed = true;
          continue;
        }
        if (task.maxRuns !== null && task.runCount >= task.maxRuns) {
          changed = true;
          continue;
        }
        const nextRunAt = getFirstFutureRun({ firstRunAt: task.nextRunAt, intervalMs: task.intervalMs, now });
        if (nextRunAt === null || (task.expiresAt !== null && nextRunAt > task.expiresAt)) {
          changed = true;
          continue;
        }
        const recovered = nextRunAt === task.nextRunAt ? task : { ...task, nextRunAt };
        changed ||= recovered !== task;
        next.push(recovered);
      }
      if (changed) {
        await this.persistSnapshot(next);
        this.replaceSnapshot(next);
      }
      this.scheduleNext();
    });
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  scheduleNext() {
    this.stop();
    if (!this.apiClient || this.tasks.size === 0) return;
    const nextTask = [...this.tasks.values()].reduce((earliest, task) => {
      const dueAt = task.retryAt ?? task.nextRunAt;
      return !earliest || dueAt < (earliest.retryAt ?? earliest.nextRunAt) ? task : earliest;
    }, null);
    const dueAt = nextTask.retryAt ?? nextTask.nextRunAt;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.processDue().catch((error) => this.logger?.error(`Cron scheduler failed: ${error?.message ?? error}`));
    }, Math.max(0, dueAt - this.now()));
    this.timer.unref?.();
  }

  async processDue() {
    if (this.processing) return;
    this.processing = true;
    try {
      if (!this.runtimeControl.isEnabled()) {
        await this.recoverMissedRuns();
        return;
      }
      const now = this.now();
      for (const task of this.getSnapshot()) {
        if ((task.retryAt ?? task.nextRunAt) <= now) await this.deliver(task);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  async deliver(task) {
    try {
      const message = task.notifyCreator
        ? [{ type: 'at', data: { qq: task.creatorUserId } }, { type: 'text', data: { text: task.content } }]
        : task.content;
      await this.apiClient.sendGroupMessage(task.groupId, message);
      await this.resolveDelivery(task, false);
    } catch (error) {
      this.logger?.warn(`Cron delivery failed for ${task.id}: ${error?.message ?? error}`);
      const retryCount = task.retryCount + 1;
      if (retryCount < 3) {
        await this.replaceTask({ ...task, retryCount, retryAt: this.now() + 60_000 });
        return;
      }
      try {
        await this.apiClient.sendGroupMessage(task.groupId, [{ type: 'at', data: { qq: task.creatorUserId } }, { type: 'text', data: { text: 'cron失败' } }]);
      } catch (notifyError) {
        this.logger?.warn(`Cron failure notice failed for ${task.id}: ${notifyError?.message ?? notifyError}`);
      }
      await this.resolveDelivery(task, true);
    }
  }

  async resolveDelivery(task, failed) {
    const current = this.tasks.get(task.id);
    if (!current) return;
    if (current.intervalMs === null) {
      await this.removeTask(current.id);
      return;
    }
    const runCount = current.runCount + 1;
    const nextRunAt = current.nextRunAt + current.intervalMs;
    if ((current.maxRuns !== null && runCount >= current.maxRuns) || (current.expiresAt !== null && nextRunAt > current.expiresAt)) {
      await this.removeTask(current.id);
      return;
    }
    await this.replaceTask({ ...current, runCount, nextRunAt, retryCount: 0, retryAt: null });
  }

  async replaceTask(task) {
    await this.enqueue(async () => {
      const next = [...this.tasks.values()].map((item) => item.id === task.id ? task : item);
      await this.persistSnapshot(next);
      this.replaceSnapshot(next);
    });
  }

  async removeTask(taskId) {
    await this.enqueue(async () => {
      const next = [...this.tasks.values()].filter((task) => task.id !== taskId);
      await this.persistSnapshot(next);
      this.replaceSnapshot(next);
    });
  }

  async enqueue(operation) {
    const nextOperation = this.writeQueue.then(operation);
    this.writeQueue = nextOperation.catch(() => {});
    return nextOperation;
  }

  async persistSnapshot(tasks) {
    const normalized = normalizeSnapshot({ tasks });
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify({ tasks: normalized }, null, 2)}\n`, 'utf8');
    try {
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
