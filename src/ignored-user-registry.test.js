import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IgnoredUserRegistry } from './ignored-user-registry.js';

test('IgnoredUserRegistry persists a global ignore set and reloads it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-ignored-users-'));
  const filePath = path.join(dir, 'config', 'ignored-users.json');

  try {
    const registry = new IgnoredUserRegistry({ filePath });
    await registry.initialize();
    await registry.add('400001');
    assert.equal(registry.has('400001'), true);

    const reloaded = new IgnoredUserRegistry({ filePath });
    await reloaded.initialize();
    assert.equal(reloaded.has('400001'), true);

    await reloaded.remove('400001');
    const cleared = new IgnoredUserRegistry({ filePath });
    await cleared.initialize();
    assert.equal(cleared.has('400001'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IgnoredUserRegistry keeps last-known-good snapshot on invalid reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-ignored-users-'));
  const filePath = path.join(dir, 'ignored-users.json');

  try {
    const registry = new IgnoredUserRegistry({ filePath });
    await registry.add('400001');
    fs.writeFileSync(filePath, '{ invalid', 'utf8');
    const result = await registry.reloadFromDisk();
    assert.equal(result.ok, false);
    assert.equal(registry.has('400001'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
