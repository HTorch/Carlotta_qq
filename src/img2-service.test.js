import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateImg2 } from './img2-service.js';

function createTempCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-img2-service-'));
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

test('generateImg2 posts JSON and parses url output', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.LUMIO_IMAGE_API_KEY;
  const cacheDirectory = createTempCache();
  const repositoryCacheBefore = snapshotRepositoryImg2Cache();

  const responseHeaders = new Headers({ 'content-type': 'application/json' });
  let requestCount = 0;
  let capturedRequest = null;

  globalThis.fetch = async (url, init) => {
    requestCount += 1;
    capturedRequest = { url, init };

    return {
      ok: true,
      status: 200,
      headers: responseHeaders,
      text: async () => JSON.stringify({ data: { url: 'https://example.invalid/generated.png' } }),
    };
  };

  process.env.LUMIO_IMAGE_API_KEY = 'test-key';

  try {
    const result = await generateImg2({ prompt: '一只猫', imageUrls: [], dependencyOverrides: { cacheDirectory } });

    assert.equal(requestCount, 1);
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.url, 'https://example.invalid/image-api/v1/images/generations');
    assert.equal(capturedRequest.init.method, 'POST');
    assert.equal(capturedRequest.init.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(capturedRequest.init.body).prompt, '一只猫');
    assert.deepEqual(result, { type: 'url', value: 'https://example.invalid/generated.png' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.LUMIO_IMAGE_API_KEY;
    } else {
      process.env.LUMIO_IMAGE_API_KEY = originalApiKey;
    }
    removeTempCache(cacheDirectory);
    assert.deepEqual(snapshotRepositoryImg2Cache(), repositoryCacheBefore);
  }
});

test('generateImg2 persists base64 output to a file', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.LUMIO_IMAGE_API_KEY;
  const cacheDirectory = createTempCache();
  const repositoryCacheBefore = snapshotRepositoryImg2Cache();
  let outputPath = null;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ b64_json: Buffer.from('hello').toString('base64') }),
  });
  process.env.LUMIO_IMAGE_API_KEY = 'test-key';

  try {
    const result = await generateImg2({ prompt: '一只猫', imageUrls: [], dependencyOverrides: { cacheDirectory } });
    outputPath = result.value;

    assert.equal(result.type, 'file');
    assert.equal(fs.existsSync(result.value), true);
    assert.equal(fs.readFileSync(result.value, 'utf8'), 'hello');
  } finally {
    if (outputPath && fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.LUMIO_IMAGE_API_KEY;
    } else {
      process.env.LUMIO_IMAGE_API_KEY = originalApiKey;
    }
    removeTempCache(cacheDirectory);
    assert.deepEqual(snapshotRepositoryImg2Cache(), repositoryCacheBefore);
  }
});

test('generateImg2 can inject a fresh requestLumioImage', async () => {
  const originalApiKey = process.env.LUMIO_IMAGE_API_KEY;
  process.env.LUMIO_IMAGE_API_KEY = 'test-key';

  try {
    const result = await generateImg2({
      prompt: '一只猫',
      imageUrls: [],
      dependencyOverrides: {
        requestLumioImage: async () => ({ type: 'url', value: 'https://example.invalid/override.png' }),
      },
    });

    assert.deepEqual(result, { type: 'url', value: 'https://example.invalid/override.png' });
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.LUMIO_IMAGE_API_KEY;
    } else {
      process.env.LUMIO_IMAGE_API_KEY = originalApiKey;
    }
  }
});
