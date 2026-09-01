import assert from 'node:assert/strict';
import test from 'node:test';

import { createShutdown } from './index.js';

test('createShutdown stops components and releases the runtime once', () => {
  const calls = [];
  const shutdown = createShutdown({
    getApiClient: () => ({ stop: () => calls.push('api') }),
    getHotRuntime: () => ({ stop: () => calls.push('runtime') }),
    releaseRuntime: () => calls.push('release'),
  });

  shutdown();
  shutdown();

  assert.deepEqual(calls, ['runtime', 'api', 'release']);
});

test('createShutdown continues cleanup when one component throws', () => {
  const calls = [];
  const errors = [];
  const shutdown = createShutdown({
    getApiClient: () => ({ stop: () => calls.push('api') }),
    getHotRuntime: () => ({ stop: () => { calls.push('runtime'); throw new Error('watch cleanup failed'); } }),
    releaseRuntime: () => calls.push('release'),
    onError: (error) => errors.push(error.message),
  });

  shutdown();

  assert.deepEqual(calls, ['runtime', 'api', 'release']);
  assert.deepEqual(errors, ['watch cleanup failed']);
});
