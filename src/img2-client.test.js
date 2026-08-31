import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { requestLumioImage } from './img2-client.js';

function createTempCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-img2-client-'));
}

function removeTempCache(cacheDirectory) {
  fs.rmSync(cacheDirectory, { recursive: true, force: true });
}

function snapshotRepositoryImg2Cache() {
  const cacheRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cache');
  const snapshot = {};

  for (const cacheName of ['img2_outputs', 'img2_references']) {
    const cacheDirectory = path.join(cacheRoot, cacheName);
    if (!fs.existsSync(cacheDirectory)) {
      continue;
    }

    for (const entry of fs.readdirSync(cacheDirectory)) {
      const filePath = path.join(cacheDirectory, entry);
      if (fs.statSync(filePath).isFile()) {
        snapshot[path.relative(cacheRoot, filePath)] = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      }
    }
  }

  return snapshot;
}

test('requestLumioImage isolates reference and output files in an injected cache', async () => {
  const originalFetch = globalThis.fetch;
  const cacheDirectory = createTempCache();
  const repositoryCacheBefore = snapshotRepositoryImg2Cache();
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url === 'file:///tmp/reference.png') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => Buffer.from('reference'),
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ b64_json: Buffer.from('generated').toString('base64') }),
    };
  };

  try {
    const result = await requestLumioImage({
      apiKey: 'test-key',
      prompt: '一只猫',
      imageUrls: ['file:///tmp/reference.png'],
      size: '1024x1024',
      cacheDirectory,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'file:///tmp/reference.png');
    assert.equal(requests[1].url, 'https://example.invalid/image-api/v1/images/edits');
    assert.equal(result.type, 'file');
    assert.equal(fs.readFileSync(result.value, 'utf8'), 'generated');
    assert.equal(fs.readFileSync(path.join(cacheDirectory, 'img2_references', 'reference-0.png'), 'utf8'), 'reference');
  } finally {
    globalThis.fetch = originalFetch;
    removeTempCache(cacheDirectory);
    assert.deepEqual(snapshotRepositoryImg2Cache(), repositoryCacheBefore);
  }
});

test('requestLumioImage preserves a non-retryable upstream failure', async () => {
  const originalFetch = globalThis.fetch;
  const cacheDirectory = createTempCache();
  const repositoryCacheBefore = snapshotRepositoryImg2Cache();

  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ message: 'invalid prompt' }),
  });

  try {
    await assert.rejects(
      requestLumioImage({ apiKey: 'test-key', prompt: '一只猫', imageUrls: [], size: '1024x1024', cacheDirectory }),
      { message: 'invalid prompt' },
    );
    assert.deepEqual(fs.readdirSync(cacheDirectory), []);
  } finally {
    globalThis.fetch = originalFetch;
    removeTempCache(cacheDirectory);
    assert.deepEqual(snapshotRepositoryImg2Cache(), repositoryCacheBefore);
  }
});
