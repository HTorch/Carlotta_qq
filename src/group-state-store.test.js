import assert from 'node:assert/strict';
import test from 'node:test';

import { GroupStateStore } from './group-state-store.js';

test('GroupStateStore resolves configured defaults only for fresh groups', () => {
  const store = new GroupStateStore({
    groupDefaults: {
      300001: { motherModeEnabled: true, sphereLightningModeEnabled: true },
    },
  });

  assert.deepEqual(store.getGroupDefaultsSnapshot(), {
    '300001': { motherModeEnabled: true, sphereLightningModeEnabled: true },
  });
  assert.equal(store.get(300001).motherModeEnabled, true);
  assert.equal(store.get('300001').sphereLightningModeEnabled, true);
  assert.equal(store.get('other').motherModeEnabled, false);
  assert.equal(store.get('other').sphereLightningModeEnabled, false);
});

test('GroupStateStore replaces defaults without rewriting existing state', () => {
  const store = new GroupStateStore({
    groupDefaults: {
      old: { motherModeEnabled: true, sphereLightningModeEnabled: false },
    },
  });
  const existing = store.get('old');

  store.replaceGroupDefaults({
    old: { motherModeEnabled: false, sphereLightningModeEnabled: true },
    fresh: { motherModeEnabled: true, sphereLightningModeEnabled: false },
  });

  assert.strictEqual(store.get('old'), existing);
  assert.equal(store.get('old').motherModeEnabled, true);
  assert.equal(store.get('old').sphereLightningModeEnabled, false);
  assert.equal(store.get('fresh').motherModeEnabled, true);
});

test('GroupStateStore validates and atomically preserves defaults on replacement failure', () => {
  const store = new GroupStateStore({
    groupDefaults: {
      stable: { motherModeEnabled: true, sphereLightningModeEnabled: false },
    },
  });
  const before = store.getGroupDefaultsSnapshot();

  assert.throws(
    () => store.replaceGroupDefaults({ broken: { motherModeEnabled: 'yes' } }),
    /motherModeEnabled/,
  );
  assert.deepEqual(store.getGroupDefaultsSnapshot(), before);
});
