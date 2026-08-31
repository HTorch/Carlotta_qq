import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GroupPromptRegistry } from './group-prompt-registry.js';

function createTempPromptPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-prompts-'));
  return { dir, file: path.join(dir, 'config', 'group-prompts.json') };
}

test('GroupPromptRegistry starts empty when its file is missing and persists set/clear', async () => {
  const { dir, file } = createTempPromptPath();

  try {
    const registry = new GroupPromptRegistry({ filePath: file });
    assert.equal(registry.get('300001'), null);

    await registry.set('300001', '保留 | 内部分隔符');
    assert.equal(registry.get('300001'), '保留 | 内部分隔符');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      groups: { '300001': '保留 | 内部分隔符' },
    });

    await registry.clear('300001');
    assert.equal(registry.get('300001'), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { groups: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GroupPromptRegistry keeps the last-known-good snapshot after invalid reload', async () => {
  const { dir, file } = createTempPromptPath();

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ groups: { '300001': '有效 prompt' } }), 'utf8');
    const registry = new GroupPromptRegistry({ filePath: file });
    await registry.initialize();
    assert.equal(registry.get('300001'), '有效 prompt');

    fs.writeFileSync(file, '{ invalid', 'utf8');
    const invalidJson = await registry.reloadFromDisk();
    assert.equal(invalidJson.ok, false);
    assert.equal(registry.get('300001'), '有效 prompt');

    fs.writeFileSync(file, JSON.stringify({ groups: { '300001': 123 } }), 'utf8');
    const invalidSchema = await registry.reloadFromDisk();
    assert.equal(invalidSchema.ok, false);
    assert.equal(registry.get('300001'), '有效 prompt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
