import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HotRuntime } from './hot-runtime.js';

function withConfigEnv(rulesFile, fn) {
  const names = ['GROUP_RULES_FILE', 'NAPCAT_WS_URL', 'NAPCAT_API_WS_URL'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.GROUP_RULES_FILE = rulesFile;
  process.env.NAPCAT_WS_URL = 'ws://example.invalid/events';
  process.env.NAPCAT_API_WS_URL = 'ws://example.invalid/api';

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

function writeRules(file, groupMode, secondaryMode = null) {
  fs.writeFileSync(file, JSON.stringify({
    defaultRule: { triggerPrefix: '柯莱塔' },
    groups: {
      '300001': {
        triggerPrefix: '柯莱塔',
        motherModeEnabled: groupMode.motherModeEnabled,
        sphereLightningModeEnabled: groupMode.sphereLightningModeEnabled,
      },
      ...(secondaryMode ? {
        'new-group': {
          triggerPrefix: '柯莱塔',
          motherModeEnabled: secondaryMode.motherModeEnabled,
          sphereLightningModeEnabled: secondaryMode.sphereLightningModeEnabled,
        },
      } : {}),
    },
  }), 'utf8');
}

function createLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
  };
}

test('HotRuntime promotes a temporary startup store only after candidate construction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-runtime-'));
  const rulesFile = path.join(dir, 'group-rules.json');
  writeRules(rulesFile, { motherModeEnabled: true, sphereLightningModeEnabled: true });

  try {
    await withConfigEnv(rulesFile, async () => {
      const runtime = new HotRuntime({ apiClient: {}, logger: createLogger(), rootDir: dir });
      assert.equal(runtime.stateStore, null);
      await runtime.reload('startup-test');

      assert.ok(runtime.runtime);
      assert.ok(runtime.stateStore);
      assert.strictEqual(runtime.runtime.messageEngine.stateStore, runtime.stateStore);
      assert.equal(runtime.stateStore.get('300001').motherModeEnabled, true);
      assert.equal(runtime.stateStore.get('300001').sphereLightningModeEnabled, true);
      assert.equal(runtime.stateStore.get('unrelated').motherModeEnabled, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HotRuntime reload preserves existing state, updates fresh defaults, and rolls back failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-runtime-'));
  const rulesFile = path.join(dir, 'group-rules.json');
  writeRules(rulesFile, { motherModeEnabled: true, sphereLightningModeEnabled: false });

  try {
    await withConfigEnv(rulesFile, async () => {
      const runtime = new HotRuntime({ apiClient: {}, logger: createLogger(), rootDir: dir });
      await runtime.reload('initial');
      runtime.stateStore.setMotherModeEnabled('300001', false);
      const oldRuntime = runtime.runtime;

      writeRules(
        rulesFile,
        { motherModeEnabled: false, sphereLightningModeEnabled: true },
        { motherModeEnabled: false, sphereLightningModeEnabled: true },
      );
      await runtime.reload('updated');

      assert.notStrictEqual(runtime.runtime, oldRuntime);
      assert.equal(runtime.stateStore.get('300001').motherModeEnabled, false);
      assert.equal(runtime.stateStore.get('300001').sphereLightningModeEnabled, false);
      assert.equal(runtime.stateStore.get('new-group').sphereLightningModeEnabled, true);

      const committedRuntime = runtime.runtime;
      const committedDefaults = runtime.stateStore.getGroupDefaultsSnapshot();
      fs.writeFileSync(rulesFile, '{ invalid json', 'utf8');
      await assert.rejects(() => runtime.reload('invalid-config'), /JSON/);
      assert.strictEqual(runtime.runtime, committedRuntime);
      assert.deepEqual(runtime.stateStore.getGroupDefaultsSnapshot(), committedDefaults);
      assert.equal(runtime.stateStore.get('new-group').sphereLightningModeEnabled, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HotRuntime keeps one prompt registry across reloads and preserves last-known-good values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-runtime-'));
  const rulesFile = path.join(dir, 'group-rules.json');
  const promptFile = path.join(dir, 'config', 'group-prompts.json');
  writeRules(rulesFile, { motherModeEnabled: false, sphereLightningModeEnabled: false });
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, JSON.stringify({ groups: { '300001': '初始 prompt' } }), 'utf8');

  try {
    await withConfigEnv(rulesFile, async () => {
      const runtime = new HotRuntime({ apiClient: {}, logger: createLogger(), rootDir: dir });
      await runtime.promptRegistry.initialize();
      await runtime.reload('startup');
      runtime.roleStore.set('300001', '临时 role');
      const roleStore = runtime.roleStore;

      assert.equal(runtime.promptRegistry.get('300001'), '初始 prompt');
      const registry = runtime.promptRegistry;
      fs.writeFileSync(promptFile, JSON.stringify({ groups: { '300001': '更新 prompt' } }), 'utf8');
      await runtime.reload('prompt-updated');
      assert.strictEqual(runtime.promptRegistry, registry);
      assert.strictEqual(runtime.roleStore, roleStore);
      assert.equal(runtime.roleStore.get('300001'), '临时 role');
      assert.equal(runtime.promptRegistry.get('300001'), '更新 prompt');

      fs.writeFileSync(promptFile, '{ invalid', 'utf8');
      await runtime.reload('prompt-invalid');
      assert.equal(runtime.promptRegistry.get('300001'), '更新 prompt');
      assert.ok(runtime.runtime);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HotRuntime restores the global ignored-user registry on initialization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-runtime-'));
  const rulesFile = path.join(dir, 'group-rules.json');
  const ignoredUsersFile = path.join(dir, 'config', 'ignored-users.json');
  writeRules(rulesFile, { motherModeEnabled: false, sphereLightningModeEnabled: false });
  fs.mkdirSync(path.dirname(ignoredUsersFile), { recursive: true });
  fs.writeFileSync(ignoredUsersFile, JSON.stringify({ users: ['400001'] }), 'utf8');

  try {
    await withConfigEnv(rulesFile, async () => {
      const runtime = new HotRuntime({ apiClient: {}, logger: createLogger(), rootDir: dir });
      await runtime.ignoredUserRegistry.initialize();
      await runtime.reload('startup');
      assert.equal(runtime.ignoredUserRegistry.has('400001'), true);
      assert.strictEqual(runtime.runtime.messageEngine.ignoredUserRegistry, runtime.ignoredUserRegistry);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HotRuntime stop removes watchers, cancels reload and cron timers, and is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-runtime-'));
  const rulesFile = path.join(dir, 'config', 'group-rules.json');
  const watchedFiles = [
    'config.js',
    'img2-service.js',
    'img2-client.js',
    'rule-registry.js',
    'action-registry.js',
    'message-engine.js',
  ];
  fs.mkdirSync(path.join(dir, 'src', 'actions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  for (const file of watchedFiles) {
    fs.writeFileSync(path.join(dir, 'src', file), '', 'utf8');
  }
  writeRules(rulesFile, { motherModeEnabled: false, sphereLightningModeEnabled: false });

  const watchCalls = [];
  const unwatchCalls = [];
  const fsModule = {
    statSync: fs.statSync.bind(fs),
    watchFile(target, options, listener) {
      watchCalls.push({ target, options, listener });
    },
    unwatchFile(target, listener) {
      unwatchCalls.push({ target, listener });
    },
  };
  const reloadTimers = createTimerHarness();
  const cronTimers = createTimerHarness();

  try {
    await withConfigEnv(rulesFile, async () => {
      const runtime = new HotRuntime({
        apiClient: { sendGroupMessage: async () => {} },
        logger: createLogger(),
        rootDir: dir,
        fsModule,
        setTimeoutFn: reloadTimers.setTimeoutFn,
        clearTimeoutFn: reloadTimers.clearTimeoutFn,
        cronSetTimer: cronTimers.setTimeoutFn,
        cronClearTimer: cronTimers.clearTimeoutFn,
      });
      runtime.startWatching();
      assert.equal(watchCalls.length, 9);

      runtime.watchers[0].listener({ mtimeMs: 2, size: 2 }, { mtimeMs: 1, size: 1 });
      runtime.cronScheduler.replaceSnapshot([{
        id: 'task-1',
        groupId: '300001',
        creatorUserId: '400001',
        content: 'reminder',
        firstRunAt: Date.now() + 10_000,
        intervalMs: null,
        expiresAt: null,
        maxRuns: null,
        runCount: 0,
        notifyCreator: true,
        nextRunAt: Date.now() + 10_000,
        retryCount: 0,
        retryAt: null,
        status: 'active',
      }]);
      runtime.cronScheduler.scheduleNext();

      runtime.stop();
      runtime.stop();

      assert.equal(unwatchCalls.length, 9);
      assert.deepEqual(unwatchCalls, watchCalls.map(({ target, listener }) => ({ target, listener })));
      assert.equal(reloadTimers.timers.length, 1);
      assert.equal(reloadTimers.timers[0].cleared, true);
      assert.equal(cronTimers.timers.length, 1);
      assert.equal(cronTimers.timers[0].cleared, true);
      runtime.cronScheduler.scheduleNext();
      assert.equal(cronTimers.timers.length, 1);
      assert.deepEqual(runtime.watchers, []);
      assert.equal(runtime.reloadTimer, null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
