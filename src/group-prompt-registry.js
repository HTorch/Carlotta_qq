import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_PROMPT_CHARS = 4000;
const GROUP_ID_PATTERN = /^\d{5,12}$/u;

function validatePromptText(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('group prompt must be a non-empty string');
  }

  if (Array.from(prompt).length > MAX_PROMPT_CHARS) {
    throw new Error(`group prompt must be at most ${MAX_PROMPT_CHARS} characters`);
  }

  return prompt;
}

function normalizeSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('group prompt config must be an object');
  }

  const groups = value.groups ?? {};
  if (groups === null || typeof groups !== 'object' || Array.isArray(groups)) {
    throw new Error('group prompt groups must be an object');
  }

  const normalized = {};
  for (const [groupId, prompt] of Object.entries(groups)) {
    if (!GROUP_ID_PATTERN.test(groupId)) {
      throw new Error(`invalid group prompt id: ${groupId}`);
    }

    normalized[groupId] = validatePromptText(prompt);
  }

  return normalized;
}

export class GroupPromptRegistry {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.prompts = new Map();
    this.writeQueue = Promise.resolve();
  }

  get(groupId) {
    return this.prompts.get(String(groupId)) ?? null;
  }

  getPrompt(groupId) {
    return this.get(groupId);
  }

  async initialize() {
    await this.reloadFromDisk();
  }

  async reloadFromDisk() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const snapshot = normalizeSnapshot(JSON.parse(content));
      this.replaceSnapshot(snapshot);
      return { ok: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.replaceSnapshot({});
        return { ok: true };
      }

      return { ok: false, error };
    }
  }

  async set(groupId, prompt) {
    const normalizedGroupId = String(groupId);
    if (!GROUP_ID_PATTERN.test(normalizedGroupId)) {
      throw new Error(`invalid group prompt id: ${normalizedGroupId}`);
    }

    const normalizedPrompt = validatePromptText(prompt);
    await this.enqueueWrite(() => {
      const next = this.getSnapshot();
      next[normalizedGroupId] = normalizedPrompt;
      return this.persistSnapshot(next);
    });
  }

  async clear(groupId) {
    const normalizedGroupId = String(groupId);
    if (!GROUP_ID_PATTERN.test(normalizedGroupId)) {
      throw new Error(`invalid group prompt id: ${normalizedGroupId}`);
    }

    await this.enqueueWrite(() => {
      const next = this.getSnapshot();
      delete next[normalizedGroupId];
      return this.persistSnapshot(next);
    });
  }

  replaceSnapshot(snapshot) {
    this.prompts = new Map(Object.entries(snapshot));
  }

  getSnapshot() {
    return Object.fromEntries(this.prompts.entries());
  }

  async enqueueWrite(operation) {
    const nextOperation = this.writeQueue.then(operation);
    this.writeQueue = nextOperation.catch(() => {});
    await nextOperation;
  }

  async persistSnapshot(snapshot) {
    const normalizedSnapshot = normalizeSnapshot({ groups: snapshot });
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify({ groups: normalizedSnapshot }, null, 2)}\n`, 'utf8');

    try {
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }

    this.replaceSnapshot(normalizedSnapshot);
  }
}
