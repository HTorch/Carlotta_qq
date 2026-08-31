import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { ChatService } from './chat-service.js';

test('ChatService sends OpenAI-compatible requests with the default model', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.CHAT_API_BASE_URL;
  const originalApiKey = process.env.CHAT_API_KEY;
  const originalModel = process.env.CHAT_MODEL;
  const originalReadFileSync = fs.readFileSync;

  process.env.CHAT_API_BASE_URL = 'https://example.invalid/chat/v1';
  process.env.CHAT_API_KEY = 'test-key';
  delete process.env.CHAT_MODEL;
  fs.readFileSync = () => {
    throw new Error('missing env file');
  };

  let capturedRequest = null;
  globalThis.fetch = async (url, init) => {
    capturedRequest = { url, init };
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: '好的' } }] }),
    };
  };

  try {
    const service = new ChatService();
    const reply = await service.completeChat({
      messages: [{ role: 'user', content: '你好' }],
    });

    assert.equal(reply, '好的');
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.url, 'https://example.invalid/chat/v1/chat/completions');

    const payload = JSON.parse(capturedRequest.init.body);
    assert.equal(payload.model, 'gpt-4o-mini');
    assert.deepEqual(payload.messages, [{ role: 'user', content: '你好' }]);
    assert.equal(payload.stream, false);
    assert.equal(capturedRequest.init.headers.Authorization, 'Bearer test-key');
  } finally {
    globalThis.fetch = originalFetch;
    fs.readFileSync = originalReadFileSync;
    process.env.CHAT_API_BASE_URL = originalBaseUrl;
    process.env.CHAT_API_KEY = originalApiKey;
    if (originalModel === undefined) {
      delete process.env.CHAT_MODEL;
    } else {
      process.env.CHAT_MODEL = originalModel;
    }
  }
});

test('ChatService keeps transcripts bounded per group', () => {
  const service = new ChatService({ maxTranscriptMessages: 4 });

  service.recordUserMessage('1', 'u1');
  service.recordAssistantMessage('1', 'a1');
  service.recordUserMessage('1', 'u2');
  service.recordAssistantMessage('1', 'a2');
  service.recordUserMessage('1', 'u3');
  service.recordAssistantMessage('1', 'a3');

  assert.deepEqual(service.getTranscript('1'), [
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
  ]);

  service.clearAllTranscripts();
  assert.deepEqual(service.getTranscript('1'), []);
});

test('ChatService compactTranscript atomically replaces one group with a hidden system summary', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.CHAT_API_BASE_URL;
  const originalApiKey = process.env.CHAT_API_KEY;
  const originalReadFileSync = fs.readFileSync;
  const requests = [];

  process.env.CHAT_API_BASE_URL = 'https://example.test/v1';
  process.env.CHAT_API_KEY = 'test-key';
  fs.readFileSync = () => {
    throw new Error('missing env file');
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: '群聊摘要' } }] }),
    };
  };

  try {
    const service = new ChatService();
    service.recordUserMessage(42, '记住这件事');
    service.recordAssistantMessage('42', '好的');
    service.recordUserMessage('other', '不要改变');

    const result = await service.compactTranscript(42);

    assert.deepEqual(result, [{ role: 'system', content: '群聊摘要' }]);
    assert.deepEqual(service.getTranscript('42'), [{ role: 'system', content: '群聊摘要' }]);
    assert.deepEqual(service.getTranscript('other'), [{ role: 'user', content: '不要改变' }]);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].init.body);
    assert.deepEqual(payload.messages, [
      {
        role: 'system',
        content: 'Summarize the following chat transcript into a concise memory for future replies. Return only the summary.',
      },
      { role: 'user', content: '记住这件事' },
      { role: 'assistant', content: '好的' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.readFileSync = originalReadFileSync;
    process.env.CHAT_API_BASE_URL = originalBaseUrl;
    process.env.CHAT_API_KEY = originalApiKey;
  }
});

test('ChatService compactTranscript places prompt and role before the summary instruction', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.CHAT_API_BASE_URL;
  const originalApiKey = process.env.CHAT_API_KEY;
  const originalReadFileSync = fs.readFileSync;
  let capturedMessages = null;

  process.env.CHAT_API_BASE_URL = 'https://example.test/v1';
  process.env.CHAT_API_KEY = 'test-key';
  fs.readFileSync = () => {
    throw new Error('missing env file');
  };
  globalThis.fetch = async (url, init) => {
    capturedMessages = JSON.parse(init.body).messages;
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: '摘要' } }] }),
    };
  };

  try {
    const service = new ChatService();
    service.recordUserMessage('300001', '历史问题');
    await service.compactTranscript('300001', { prompt: '群 prompt', role: '群 role' });

    assert.deepEqual(capturedMessages, [
      { role: 'system', content: '群 prompt' },
      { role: 'system', content: '群 role' },
      {
        role: 'system',
        content: 'Summarize the following chat transcript into a concise memory for future replies. Return only the summary.',
      },
      { role: 'user', content: '历史问题' },
    ]);
    assert.deepEqual(service.getTranscript('300001'), [{ role: 'system', content: '摘要' }]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.readFileSync = originalReadFileSync;
    process.env.CHAT_API_BASE_URL = originalBaseUrl;
    process.env.CHAT_API_KEY = originalApiKey;
  }
});

test('ChatService compactTranscript skips the API for an empty group', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    throw new Error('fetch must not be called');
  };

  try {
    const service = new ChatService();
    assert.deepEqual(await service.compactTranscript('empty'), []);
    assert.equal(callCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ChatService compactTranscript preserves the original transcript after API or summary failure', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.CHAT_API_BASE_URL;
  const originalApiKey = process.env.CHAT_API_KEY;
  const originalReadFileSync = fs.readFileSync;
  const originalTranscript = [
    { role: 'user', content: '原始问题' },
    { role: 'assistant', content: '原始回答' },
  ];

  process.env.CHAT_API_BASE_URL = 'https://example.test/v1';
  process.env.CHAT_API_KEY = 'test-key';
  fs.readFileSync = () => {
    throw new Error('missing env file');
  };

  try {
    for (const responseText of [
      null,
      JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
    ]) {
      const service = new ChatService();
      service.recordUserMessage('group', originalTranscript[0].content);
      service.recordAssistantMessage('group', originalTranscript[1].content);
      globalThis.fetch = async () => {
        if (responseText === null) {
          throw new Error('network failure');
        }

        return { ok: true, text: async () => responseText };
      };

      await assert.rejects(() => service.compactTranscript('group'));
      assert.deepEqual(service.getTranscript('group'), originalTranscript);
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.readFileSync = originalReadFileSync;
    process.env.CHAT_API_BASE_URL = originalBaseUrl;
    process.env.CHAT_API_KEY = originalApiKey;
  }
});

test('ChatService compactTranscript normalizes timeout failures and preserves the transcript', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.CHAT_API_BASE_URL;
  const originalApiKey = process.env.CHAT_API_KEY;
  const originalReadFileSync = fs.readFileSync;

  process.env.CHAT_API_BASE_URL = 'https://example.test/v1';
  process.env.CHAT_API_KEY = 'test-key';
  fs.readFileSync = () => {
    throw new Error('missing env file');
  };
  globalThis.fetch = async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  };

  try {
    const service = new ChatService();
    service.recordUserMessage('group', '超时前的问题');
    service.recordAssistantMessage('group', '超时前的回答');
    const originalTranscript = service.getTranscript('group');

    await assert.rejects(
      () => service.compactTranscript('group'),
      { message: 'Chat API request timed out after 120s' },
    );
    assert.deepEqual(service.getTranscript('group'), originalTranscript);
  } finally {
    globalThis.fetch = originalFetch;
    fs.readFileSync = originalReadFileSync;
    process.env.CHAT_API_BASE_URL = originalBaseUrl;
    process.env.CHAT_API_KEY = originalApiKey;
  }
});

test('ChatService clearTranscript clears only one per-group transcript', () => {
  const service = new ChatService();
  service.recordUserMessage(7, '要清掉');
  service.recordUserMessage('8', '要保留');

  service.clearTranscript('7');

  assert.deepEqual(service.getTranscript(7), []);
  assert.deepEqual(service.getTranscript(8), [{ role: 'user', content: '要保留' }]);
});
