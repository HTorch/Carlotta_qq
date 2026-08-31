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
