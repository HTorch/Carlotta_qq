import fs from 'node:fs/promises';
import path from 'node:path';

const USER_ID_PATTERN = /^\d{5,12}$/u;

function normalizeSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ignored user config must be an object');
  }

  const users = value.users ?? [];
  if (!Array.isArray(users)) {
    throw new Error('ignored user users must be an array');
  }

  const normalized = new Set();
  for (const userId of users) {
    const normalizedUserId = String(userId);
    if (!USER_ID_PATTERN.test(normalizedUserId)) {
      throw new Error(`invalid ignored user id: ${normalizedUserId}`);
    }
    normalized.add(normalizedUserId);
  }

  return normalized;
}

export class IgnoredUserRegistry {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.userIds = new Set();
    this.writeQueue = Promise.resolve();
  }

  has(userId) {
    return this.userIds.has(String(userId));
  }

  async initialize() {
    return this.reloadFromDisk();
  }

  async reloadFromDisk() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.replaceSnapshot(normalizeSnapshot(JSON.parse(content)));
      return { ok: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.replaceSnapshot(new Set());
        return { ok: true };
      }

      return { ok: false, error };
    }
  }

  async add(userId) {
    const normalizedUserId = this.validateUserId(userId);
    await this.enqueueWrite(() => {
      const next = this.getSnapshot();
      next.add(normalizedUserId);
      return this.persistSnapshot(next);
    });
  }

  async remove(userId) {
    const normalizedUserId = this.validateUserId(userId);
    await this.enqueueWrite(() => {
      const next = this.getSnapshot();
      next.delete(normalizedUserId);
      return this.persistSnapshot(next);
    });
  }

  validateUserId(userId) {
    const normalizedUserId = String(userId);
    if (!USER_ID_PATTERN.test(normalizedUserId)) {
      throw new Error(`invalid ignored user id: ${normalizedUserId}`);
    }
    return normalizedUserId;
  }

  replaceSnapshot(snapshot) {
    this.userIds = new Set(snapshot);
  }

  getSnapshot() {
    return new Set(this.userIds);
  }

  async enqueueWrite(operation) {
    const nextOperation = this.writeQueue.then(operation);
    this.writeQueue = nextOperation.catch(() => {});
    await nextOperation;
  }

  async persistSnapshot(snapshot) {
    const normalizedSnapshot = normalizeSnapshot({ users: [...snapshot] });
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify({ users: [...normalizedSnapshot] }, null, 2)}\n`, 'utf8');

    try {
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }

    this.replaceSnapshot(normalizedSnapshot);
  }
}
