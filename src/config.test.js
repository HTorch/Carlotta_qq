import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from './config.js';
import { redactUrlForLog } from './onebot-client.js';

function withConfigEnv(env, fn) {
  const keys = Object.keys(env);
  const previousValues = new Map(keys.map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      const previousValue = previousValues.get(key);
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

function createRulesFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-config-'));
  const rulesFile = path.join(dir, 'group-rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({ defaultRule: {}, groups: {} }), 'utf8');
  return rulesFile;
}

function createRulesFileWithContents(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carlotta-config-'));
  const rulesFile = path.join(dir, 'group-rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify(contents), 'utf8');
  return rulesFile;
}

test('loadConfig remaps the local Napcat API WS URL to the root endpoint', () => {
  const rulesFile = createRulesFile();

  withConfigEnv(
    {
      GROUP_RULES_FILE: rulesFile,
    NAPCAT_WS_URL: 'ws://example.invalid:3001/events',
    NAPCAT_API_WS_URL: 'ws://example.invalid:3001/api',
       SNOWLUMA_ACCESS_TOKEN: 'test-token',
      LOG_LEVEL: 'debug',
    },
    () => {
      const config = loadConfig();

  assert.equal(config.napcat.eventUrl, 'ws://example.invalid:3001/events');
  assert.equal(config.napcat.apiUrl, 'ws://example.invalid:3001/');
      assert.equal(config.logLevel, 'debug');
    },
  );
});

test('loadConfig preserves non-local Napcat API WS URLs', () => {
  const rulesFile = createRulesFile();

  withConfigEnv(
    {
      GROUP_RULES_FILE: rulesFile,
      NAPCAT_WS_URL: 'ws://example.invalid/',
      NAPCAT_API_WS_URL: 'ws://example.invalid/api',
       SNOWLUMA_ACCESS_TOKEN: 'test-token',
      LOG_LEVEL: 'info',
    },
    () => {
      const config = loadConfig();

      assert.equal(config.napcat.apiUrl, 'ws://example.invalid/api');
    },
  );
});

test('loadConfig rejects invalid Napcat WebSocket URLs', () => {
  const rulesFile = createRulesFile();

  withConfigEnv(
    {
      GROUP_RULES_FILE: rulesFile,
      NAPCAT_WS_URL: 'http://example.invalid/events',
      NAPCAT_API_WS_URL: 'ws://example.invalid/api',
    },
    () => assert.throws(
      () => loadConfig(),
      /Invalid NAPCAT_WS_URL: expected a valid ws:\/\/ or wss:\/\/ URL/u,
    ),
  );
});

test('loadConfig rejects malformed WebSocket URL syntax', () => {
  const rulesFile = createRulesFile();

  withConfigEnv(
    {
      GROUP_RULES_FILE: rulesFile,
      NAPCAT_WS_URL: 'not a URL',
      NAPCAT_API_WS_URL: 'ws://example.invalid/api',
    },
    () => assert.throws(
      () => loadConfig(),
      /Invalid NAPCAT_WS_URL: expected a valid ws:\/\/ or wss:\/\/ URL/u,
    ),
  );
});

test('loadConfig rejects invalid group-rule structure', () => {
  for (const contents of [
    [],
    { defaultRule: null, groups: {} },
    { defaultRule: {}, groups: [] },
  ]) {
    const rulesFile = createRulesFileWithContents(contents);

    withConfigEnv(
      {
        GROUP_RULES_FILE: rulesFile,
        NAPCAT_WS_URL: 'ws://example.invalid/events',
        NAPCAT_API_WS_URL: 'ws://example.invalid/api',
      },
      () => assert.throws(() => loadConfig(), /Invalid group rules:/u),
    );
  }
});

test('redactUrlForLog removes query and fragment data', () => {
  const redacted = redactUrlForLog(
    'wss://example.invalid/events?access_token=secret&other=private#fragment',
  );

  assert.equal(redacted, 'wss://example.invalid/events');
  assert.doesNotMatch(redacted, /secret|private|access_token/u);
});
