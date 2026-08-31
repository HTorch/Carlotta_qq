import assert from 'node:assert/strict';
import test from 'node:test';

import { GroupStateStore } from './group-state-store.js';
import { MessageEngine } from './message-engine.js';

// allow: SIZE_OK — large regression matrix for the central message dispatcher.

function createEngine({ dependencyOverrides = {}, stateStore = new GroupStateStore(), random = () => 0.25, actionRegistry = { get() { return null; } }, logger: loggerOverride = null, apiClient: apiClientOverride = null, ...restOverrides } = {}) {
  const apiCalls = [];
  const apiClient = apiClientOverride ?? {
    async sendGroupMessage(groupId, payload) {
      apiCalls.push({ groupId, payload });
    },
  };

  const ruleRegistry = {
    get() {
      return {
        triggerPrefix: '柯莱塔',
         triggerSuffix: '挂闪电',
         triggerReply: 'trigger',
         successReply: 'success',
         failureReply: 'failure',
         probability: 1,
        muteDurationSeconds: 5,
        enabledActions: ['temporaryMute'],
      };
    },
  };

  const logger = loggerOverride ?? {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  const engine = new MessageEngine({
    apiClient,
    ruleRegistry,
    stateStore,
    actionRegistry,
    logger,
    random,
    dependencyOverrides: { ...dependencyOverrides, ...restOverrides },
  });

  return { engine, apiCalls };
}

function createRuntimeControl(initialEnabled = true) {
  let enabled = initialEnabled;

  return {
    isEnabled() {
      return enabled;
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    get value() {
      return enabled;
    },
  };
}

function createChatServiceStub({ replies = ['chat reply'], compactSummary = [{ role: 'system', content: 'hidden summary' }], compactError = null } = {}) {
  const transcripts = new Map();
  const completeCalls = [];
  const compactCalls = [];
  const clearCalls = [];
  let replyIndex = 0;
  let cleared = false;

  return {
    get completeCalls() {
      return completeCalls;
    },
    get cleared() {
      return cleared;
    },
    get compactCalls() {
      return compactCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
    getTranscript(groupId) {
      return [...(transcripts.get(String(groupId)) ?? [])];
    },
    recordUserMessage(groupId, content) {
      const key = String(groupId);
      const nextTranscript = [...(transcripts.get(key) ?? []), { role: 'user', content }];
      transcripts.set(key, nextTranscript);
      return [...nextTranscript];
    },
    recordAssistantMessage(groupId, content) {
      const key = String(groupId);
      const nextTranscript = [...(transcripts.get(key) ?? []), { role: 'assistant', content }];
      transcripts.set(key, nextTranscript);
      return [...nextTranscript];
    },
    async compactTranscript(groupId) {
      compactCalls.push(String(groupId));
      if (compactError) {
        throw compactError;
      }

      transcripts.set(String(groupId), [...compactSummary]);
      return [...compactSummary];
    },
    clearTranscript(groupId) {
      clearCalls.push(String(groupId));
      transcripts.delete(String(groupId));
    },
    clearAllTranscripts() {
      cleared = true;
      transcripts.clear();
    },
    async completeChat({ messages }) {
      completeCalls.push(messages);
      const reply = replies[Math.min(replyIndex, replies.length - 1)] ?? replies.at(-1) ?? 'chat reply';
      replyIndex += 1;
      return reply;
    },
  };
}

function createPromptRegistryStub(initialPrompts = {}) {
  const prompts = new Map(Object.entries(initialPrompts));
  const calls = [];

  return {
    calls,
    get(groupId) {
      return prompts.get(String(groupId)) ?? null;
    },
    async set(groupId, prompt) {
      calls.push({ action: 'set', groupId: String(groupId), prompt });
      prompts.set(String(groupId), prompt);
    },
    async clear(groupId) {
      calls.push({ action: 'clear', groupId: String(groupId) });
      prompts.delete(String(groupId));
    },
  };
}

function createRoleStoreStub(initialRoles = {}) {
  const roles = new Map(Object.entries(initialRoles));
  const calls = [];

  return {
    calls,
    get(groupId) {
      return roles.get(String(groupId)) ?? null;
    },
    set(groupId, role) {
      calls.push({ action: 'set', groupId: String(groupId), role });
      roles.set(String(groupId), role);
    },
    clear(groupId) {
      calls.push({ action: 'clear', groupId: String(groupId) });
      roles.delete(String(groupId));
    },
    clearAll() {
      calls.push({ action: 'clearAll' });
      roles.clear();
    },
  };
}

function createContextSourceStub({ prompts = {}, roles = {} } = {}) {
  return {
    getPrompt(groupId) {
      return prompts[String(groupId)] ?? null;
    },
    getRole(groupId) {
      return roles[String(groupId)] ?? null;
    },
  };
}

test('MessageEngine lets legacy fujao and grok prompts fall through to chat', async () => {
  for (const command of ['fujao', 'fujao 随机一句', 'grok 一只猫']) {
    const chatService = createChatServiceStub({ replies: [`chat:${command}`] });
    const { engine, apiCalls } = createEngine({ chatService });

    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 2,
      self_id: 3,
      raw_message: `[CQ:at,qq=3] ${command}`,
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ` ${command}` } },
        ...(command.startsWith('grok') ? [{ type: 'image', data: { url: 'https://example.invalid/reference.png' } }] : []),
      ],
    });

    assert.deepEqual(chatService.completeCalls, [[{ role: 'user', content: command }]]);
    assert.deepEqual(apiCalls, [{ groupId: '1', payload: `chat:${command}` }]);
  }
});

test('MessageEngine only lets the PORT global admin mutate remote prompts', async () => {
  const promptRegistry = createPromptRegistryStub();
  const { engine: portEngine, apiCalls: portCalls } = createEngine({
    promptRegistry,
    userId: '100001',
  });

  await portEngine.handleGroupMessage({
    group_id: '200001',
    user_id: '100001',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] remote 300001 | prompt 你是本群助手',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' remote 300001 | prompt 你是本群助手' } },
    ],
  });

  assert.deepEqual(promptRegistry.calls, [{
    action: 'set',
    groupId: '300001',
    prompt: '你是本群助手',
  }]);
  assert.equal(portCalls.at(-1)?.payload, '已更新 300001 的群 prompt');

  const unauthorizedRegistry = createPromptRegistryStub();
  const { engine: unauthorizedEngine, apiCalls: unauthorizedCalls } = createEngine({
    promptRegistry: unauthorizedRegistry,
  });

  await unauthorizedEngine.handleGroupMessage({
    group_id: '200001',
    user_id: '2',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] remote 300001 | prompt 不该写入',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' remote 300001 | prompt 不该写入' } },
    ],
  });

  assert.deepEqual(unauthorizedRegistry.calls, []);
  assert.equal(unauthorizedCalls.at(-1)?.payload, '只有全局管理员可以管理群 prompt');
});

test('MessageEngine lets any group member set and forget the current shared role', async () => {
  const roleStore = createRoleStoreStub();
  const { engine, apiCalls } = createEngine({ roleStore });

  await engine.handleGroupMessage({
    group_id: '1',
    user_id: '2',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] role 你是一只猫',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' role 你是一只猫' } },
    ],
  });

  assert.deepEqual(roleStore.calls, [{ action: 'set', groupId: '1', role: '你是一只猫' }]);
  assert.equal(apiCalls.at(-1)?.payload, '本群临时 role 已设置');

  await engine.handleGroupMessage({
    group_id: '1',
    user_id: '2',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] forget',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' forget' } },
    ],
  });

  assert.deepEqual(roleStore.calls, [
    { action: 'set', groupId: '1', role: '你是一只猫' },
    { action: 'clear', groupId: '1' },
  ]);
  assert.equal(apiCalls.at(-1)?.payload, '本群临时 role 已清除');
});

test('MessageEngine clears shared roles with new and admin restart', async () => {
  const roleStore = createRoleStoreStub({ 1: '猫', 2: '狗' });
  const chatService = createChatServiceStub();
  const promptRegistry = createPromptRegistryStub({ 1: '持久 prompt' });
  const { engine } = createEngine({ roleStore, chatService, promptRegistry });

  await engine.handleGroupMessage({
    group_id: '1', user_id: '100001', self_id: '3',
    raw_message: '[CQ:at,qq=3] new',
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' new' } }],
  });
  await engine.handleGroupMessage({
    group_id: '1', user_id: '100001', self_id: '3',
    raw_message: '[CQ:at,qq=3] 重启',
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' 重启' } }],
  });

  assert.deepEqual(roleStore.calls, [
    { action: 'clear', groupId: '1' },
    { action: 'clearAll' },
  ]);
  assert.equal(promptRegistry.get('1'), '持久 prompt');
});

test('MessageEngine reports prompt persistence failures without exposing the prompt', async () => {
  const { engine, apiCalls } = createEngine({
    promptRegistry: {
      get() { return null; },
      async set() { throw new Error('disk failure secret=TOP_SECRET'); },
      async clear() { throw new Error('disk failure secret=TOP_SECRET'); },
    },
  });

  await engine.handleGroupMessage({
    group_id: '200001', user_id: '100001', self_id: '3',
    raw_message: '[CQ:at,qq=3] remote 300001 | prompt secret prompt',
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' remote 300001 | prompt secret prompt' } }],
  });

  assert.equal(apiCalls.at(-1)?.payload, '群 prompt 保存失败，请稍后重试');
  assert.doesNotMatch(String(apiCalls.at(-1)?.payload), /TOP_SECRET|secret prompt/);
});

test('MessageEngine composes prompt and role before transcript and current chat input', async () => {
  const chatService = createChatServiceStub();
  chatService.recordUserMessage('1', '之前的问题');
  chatService.recordAssistantMessage('1', '之前的回答');
  const { engine, apiCalls } = createEngine({
    chatService,
    promptRegistry: createContextSourceStub({ prompts: { 1: '本群 prompt' } }),
    roleStore: createContextSourceStub({ roles: { 1: '本群 role' } }),
  });

  await engine.handleGroupMessage({
    group_id: '1',
    user_id: '2',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] 现在的问题',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 现在的问题' } },
    ],
  });

  assert.deepEqual(chatService.completeCalls[0], [
    { role: 'system', content: '本群 prompt' },
    { role: 'system', content: '本群 role' },
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '之前的回答' },
    { role: 'user', content: '现在的问题' },
  ]);
  assert.equal(apiCalls.at(-1)?.payload, 'chat reply');
});

test('MessageEngine compacts with prompt and role context without duplicating them in transcript', async () => {
  const chatService = createChatServiceStub();
  chatService.recordUserMessage('1', '历史问题');
  const compactCalls = [];
  const originalCompact = chatService.compactTranscript;
  chatService.compactTranscript = async (groupId, context) => {
    compactCalls.push({ groupId: String(groupId), context });
    return originalCompact.call(chatService, groupId);
  };
  const { engine } = createEngine({
    chatService,
    promptRegistry: createContextSourceStub({ prompts: { 1: '本群 prompt' } }),
    roleStore: createContextSourceStub({ roles: { 1: '本群 role' } }),
  });

  await engine.handleGroupMessage({
    group_id: '1',
    user_id: '100001',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] compact',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' compact' } },
    ],
  });

  assert.deepEqual(compactCalls, [{
    groupId: '1',
    context: { prompt: '本群 prompt', role: '本群 role' },
  }]);
  assert.deepEqual(chatService.getTranscript('1'), [{ role: 'system', content: 'hidden summary' }]);
});

test('MessageEngine redacts prompt and role command bodies from incoming event logs', async () => {
  const logs = [];
  const logger = {
    info(...args) { logs.push(args.join(' ')); },
    warn() {},
    error() {},
    debug() {},
  };
  const { engine } = createEngine({
    logger,
    promptRegistry: createPromptRegistryStub(),
  });

  await engine.handleGroupMessage({
    group_id: '200001',
    user_id: '100001',
    self_id: '3',
    raw_message: '[CQ:at,qq=3] remote 300001 | prompt secret prompt body',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' remote 300001 | prompt secret prompt body' } },
    ],
  });

  assert.doesNotMatch(logs.join('\n'), /secret prompt body/);
});

test('MessageEngine rejects over-limit prompt and role before mutation', async () => {
  const promptRegistry = createPromptRegistryStub();
  const roleStore = createRoleStoreStub();
  const { engine, apiCalls } = createEngine({ promptRegistry, roleStore });
  const longText = '字'.repeat(400001);

  await engine.handleGroupMessage({
    group_id: '200001', user_id: '100001', self_id: '3',
    raw_message: `[CQ:at,qq=3] remote 300001 | prompt ${longText}`,
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ` remote 300001 | prompt ${longText}` } }],
  });
  await engine.handleGroupMessage({
    group_id: '1', user_id: '2', self_id: '3',
    raw_message: `[CQ:at,qq=3] role ${longText}`,
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ` role ${longText}` } }],
  });

  assert.deepEqual(promptRegistry.calls, []);
  assert.deepEqual(roleStore.calls, []);
  assert.deepEqual(apiCalls.map((call) => call.payload), [
    '群 prompt 过长，最多 4000 个字符',
    '临时 role 过长，最多 4000 个字符',
  ]);
});

test('MessageEngine uses injected img2 service', async () => {
  const { engine, apiCalls } = createEngine({
    img2Service: {
      getImageApiTimeoutSeconds: () => 123,
      generateImg2: async () => ({ type: 'url', value: 'https://example.invalid/generated.png' }),
      persistOutputImage: (value) => value,
      buildImageMessage: (value) => [{ type: 'image', data: { file: value.value } }],
      getImg2CacheDir: () => '/tmp/img2-cache',
    },
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] img2 猫',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' img2 猫' } },
    ],
  });

  assert.equal(apiCalls[0]?.payload, '正在生图，请稍等…（通常需要 30~90 秒，最长 123 秒）');
  assert.deepEqual(apiCalls[1]?.payload, [{ type: 'image', data: { file: 'https://example.invalid/generated.png' } }]);
});

test('MessageEngine repeats identical image messages', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:image,file=abc.jpg,url=https://example.invalid/a.jpg]',
    message: [{ type: 'image', data: { file: 'abc.jpg', url: 'https://example.invalid/a.jpg', summary: '[图片]' } }],
  };

  await engine.handleGroupMessage(event);
  await engine.handleGroupMessage(event);
  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.deepEqual(apiCalls[0].payload, event.message);
});

test('MessageEngine ignores self messages when counting repeats', async () => {
  const { engine, apiCalls } = createEngine();
  const userEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:image,file=abc.jpg,url=https://example.invalid/a.jpg]',
    message: [{ type: 'image', data: { file: 'abc.jpg', url: 'https://example.invalid/a.jpg', summary: '[图片]' } }],
  };
  const selfEvent = {
    ...userEvent,
    user_id: 3,
  };

  await engine.handleGroupMessage(userEvent);
  await engine.handleGroupMessage(userEvent);
  await engine.handleGroupMessage(selfEvent);

  assert.equal(apiCalls.length, 0);

  await engine.handleGroupMessage(userEvent);

  assert.equal(apiCalls.length, 1);
  assert.deepEqual(apiCalls[0].payload, userEvent.message);
});

test('MessageEngine repeats identical text messages', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: 'hello',
    message: [{ type: 'text', data: { text: 'hello' } }],
  };

  await engine.handleGroupMessage(event);
  await engine.handleGroupMessage(event);
  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload, 'hello');
});

test('MessageEngine only repeats once per continuous identical-text run', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: 'hello',
    message: [{ type: 'text', data: { text: 'hello' } }],
  };

  for (let index = 0; index < 6; index += 1) {
    await engine.handleGroupMessage(event);
  }

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload, 'hello');
});

test('MessageEngine clears repeat state on non-repeatable messages', async () => {
  const { engine, apiCalls } = createEngine();
  const repeatEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: 'hello',
    message: [{ type: 'text', data: { text: 'hello' } }],
  };
  const breakEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: 'bye',
    message: [{ type: 'text', data: { text: 'bye' } }],
  };

  for (let index = 0; index < 3; index += 1) {
    await engine.handleGroupMessage(repeatEvent);
  }

  assert.equal(apiCalls.length, 1);

  await engine.handleGroupMessage(breakEvent);

  for (let index = 0; index < 3; index += 1) {
    await engine.handleGroupMessage(repeatEvent);
  }

  assert.equal(apiCalls.length, 2);
  assert.deepEqual(apiCalls.map((call) => call.payload), ['hello', 'hello']);
});

test('MessageEngine toggles mother mode and transforms only normal text', async () => {
  const { engine, apiCalls } = createEngine();
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 母on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 母on' } },
    ],
  };
  const offEvent = {
    ...onEvent,
    raw_message: '[CQ:at,qq=3] 母off',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 母off' } },
    ],
  };
  const plainEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '找不到公厕了，雄狮和男人也来了，牡牛路过',
    message: [{ type: 'text', data: { text: '找不到公厕了，雄狮和男人也来了，牡牛路过' } }],
  };
  const pingEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] ping',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' ping' } },
    ],
  };
  const selfEvent = {
    ...plainEvent,
    user_id: 3,
  };

  await engine.handleGroupMessage(onEvent);

  assert.equal(apiCalls.at(-1)?.payload, '母关式已开启');
  assert.equal(engine.stateStore.get('1').motherModeEnabled, true);

  await engine.handleGroupMessage(plainEvent);
  assert.equal(apiCalls.at(-1)?.payload, '找不到母厕了，雌狮和女人也来了，牝牛路过');

  await engine.handleGroupMessage(pingEvent);
  assert.equal(apiCalls.at(-1)?.payload, 'pong');

  const beforeSelf = apiCalls.length;
  await engine.handleGroupMessage(selfEvent);
  assert.equal(apiCalls.length, beforeSelf);

  await engine.handleGroupMessage(offEvent);
  assert.equal(apiCalls.at(-1)?.payload, '母关式已关闭');
  assert.equal(engine.stateStore.get('1').motherModeEnabled, false);

  const beforeDisabled = apiCalls.length;
  await engine.handleGroupMessage(plainEvent);
  assert.equal(apiCalls.length, beforeDisabled);
});

test('MessageEngine expands common mother-mode words and phrases', async () => {
  const { engine, apiCalls } = createEngine();
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 母on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 母on' } },
    ],
  };
  const phraseEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '爸爸爷爷父亲公公老公老婆给给丈夫夫君相公哥哥弟弟兄弟男生男孩男人男士叔叔',
    message: [{ type: 'text', data: { text: '爸爸爷爷父亲公公老公老婆给给丈夫夫君相公哥哥弟弟兄弟男生男孩男人男士叔叔' } }],
  };

  await engine.handleGroupMessage(onEvent);
  await engine.handleGroupMessage(phraseEvent);

  assert.equal(apiCalls.at(-1)?.payload, '妈妈奶奶母亲婆婆老公老婆拉拉妻子娘子娘子姐姐妹妹姐妹女生女孩女人女士阿姨');
});

test('MessageEngine replaces 哥 character without relying on 哥哥 phrase replacement', async () => {
  const { engine, apiCalls } = createEngine();
  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 母on',
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' 母on' } }],
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '大哥 哥哥',
    message: [{ type: 'text', data: { text: '大哥 哥哥' } }],
  });

  assert.equal(apiCalls.at(-1)?.payload, '大姐 姐姐');
});

test('MessageEngine protects 老公 and 老婆 from character-level mother-mode replacement', async () => {
  const { engine, apiCalls } = createEngine();
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 母on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 母on' } },
    ],
  };
  const mixedEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '老公给给老婆',
    message: [{ type: 'text', data: { text: '老公给给老婆' } }],
  };

  await engine.handleGroupMessage(onEvent);
  await engine.handleGroupMessage(mixedEvent);

  assert.equal(apiCalls.at(-1)?.payload, '老公拉拉老婆');
});

test('MessageEngine adds a QQ to the ignore list with fuck command', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] fuck 400001',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' fuck 400001' } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0]?.payload, '已无视 QQ400001 的发言');
  assert.equal(engine.stateStore.get('1').ignoredUserIds['400001'], true);
});

test('MessageEngine applies the injected global ignore registry across groups', async () => {
  const ignoredUsers = new Set();
  const ignoredUserRegistry = {
    async add(userId) {
      ignoredUsers.add(String(userId));
    },
    async remove(userId) {
      ignoredUsers.delete(String(userId));
    },
    has(userId) {
      return ignoredUsers.has(String(userId));
    },
  };
  const { engine, apiCalls } = createEngine({ dependencyOverrides: { ignoredUserRegistry } });
  const makeEvent = (groupId, userId, text) => ({
    group_id: groupId,
    user_id: userId,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ` ${text}` } }],
  });

  await engine.handleGroupMessage(makeEvent(1, 2, 'fuck400001'));
  const beforeIgnoredMessage = apiCalls.length;
  await engine.handleGroupMessage(makeEvent(2, 400001, 'hello'));

  assert.equal(apiCalls.length, beforeIgnoredMessage);
  assert.equal(ignoredUserRegistry.has('400001'), true);
});

test('MessageEngine skips future messages from an ignored QQ', async () => {
  const { engine, apiCalls } = createEngine();
  const ignoreEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] fuck 400001',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' fuck 400001' } },
    ],
  };
  const ignoredPingEvent = {
    group_id: 1,
    user_id: 400001,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] ping',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' ping' } },
    ],
  };
  const ignoredPlainEvent = {
    group_id: 1,
    user_id: 400001,
    self_id: 3,
    raw_message: 'hello',
    message: [{ type: 'text', data: { text: 'hello' } }],
  };

  await engine.handleGroupMessage(ignoreEvent);

  const beforeIgnoredMessages = apiCalls.length;
  await engine.handleGroupMessage(ignoredPingEvent);
  await engine.handleGroupMessage(ignoredPlainEvent);
  await engine.handleGroupMessage(ignoredPlainEvent);
  await engine.handleGroupMessage(ignoredPlainEvent);

  assert.equal(apiCalls.length, beforeIgnoredMessages);
});

test('MessageEngine refuses to ignore the protected admin QQ', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] fuck100001',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' fuck100001' } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0]?.payload, 'QQ100001 是管理员，不能无视');
  assert.equal(engine.stateStore.get('1').ignoredUserIds['100001'], undefined);
});

test('MessageEngine still processes protected admin QQ even if stale ignore state exists', async () => {
  const { engine, apiCalls } = createEngine();
  engine.stateStore.ignoreUser('1', '100001');

  const event = {
    group_id: 1,
    user_id: 100001,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] ping',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' ping' } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0]?.payload, 'pong');
});

test('MessageEngine removes a QQ from the ignore list with unfuck command', async () => {
  const { engine, apiCalls } = createEngine();
  const ignoreEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] fuck400001',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' fuck400001' } },
    ],
  };
  const unignoreEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] unfuck400001',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' unfuck400001' } },
    ],
  };
  const restoredPingEvent = {
    group_id: 1,
    user_id: 400001,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] ping',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' ping' } },
    ],
  };

  await engine.handleGroupMessage(ignoreEvent);
  await engine.handleGroupMessage(unignoreEvent);

  assert.equal(apiCalls.at(-1)?.payload, '已取消无视 QQ400001 的发言');
  assert.equal(engine.stateStore.get('1').ignoredUserIds['400001'], undefined);

  const beforeRestoredPing = apiCalls.length;
  await engine.handleGroupMessage(restoredPingEvent);

  assert.equal(apiCalls.length, beforeRestoredPing + 1);
  assert.equal(apiCalls.at(-1)?.payload, 'pong');
});

test('MessageEngine routes strict remote toggle commands from PORT to the target group', async () => {
  const { engine, apiCalls } = createEngine();
  const sourceGroupId = 200001;
  const targetGroupId = '300001';

  const makeEvent = (text) => ({
    group_id: sourceGroupId,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  });

  await engine.handleGroupMessage(makeEvent(`remote ${targetGroupId} | 母on`));
  assert.equal(apiCalls.at(-1)?.groupId, String(sourceGroupId));
  assert.equal(apiCalls.at(-1)?.payload, '母关式已开启');
  assert.equal(engine.stateStore.get(targetGroupId).motherModeEnabled, true);
  assert.equal(engine.stateStore.get(String(sourceGroupId)).motherModeEnabled, false);

  await engine.handleGroupMessage(makeEvent(`remote ${targetGroupId} | 母off`));
  assert.equal(apiCalls.at(-1)?.groupId, String(sourceGroupId));
  assert.equal(apiCalls.at(-1)?.payload, '母关式已关闭');
  assert.equal(engine.stateStore.get(targetGroupId).motherModeEnabled, false);

  await engine.handleGroupMessage(makeEvent(`remote ${targetGroupId} | 球形闪电on`));
  assert.equal(apiCalls.at(-1)?.groupId, String(sourceGroupId));
  assert.equal(apiCalls.at(-1)?.payload, '球形闪电模式已开启');
  assert.equal(engine.stateStore.get(targetGroupId).sphereLightningModeEnabled, true);

  await engine.handleGroupMessage(makeEvent(`remote ${targetGroupId} | 球形闪电off`));
  assert.equal(apiCalls.at(-1)?.groupId, String(sourceGroupId));
  assert.equal(apiCalls.at(-1)?.payload, '球形闪电模式已关闭');
  assert.equal(engine.stateStore.get(targetGroupId).sphereLightningModeEnabled, false);
});

test('MessageEngine rejects valid remote commands outside PORT with one exact error', async () => {
  const { engine, apiCalls } = createEngine();
  const targetGroupId = '300001';
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] remote ${targetGroupId} | 母on`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` remote ${targetGroupId} | 母on` } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls.at(-1)?.groupId, '1');
  assert.equal(apiCalls.at(-1)?.payload, '只有 PORT 测试群可以远程执行。');
  assert.equal(engine.stateStore.get(targetGroupId).motherModeEnabled, false);
});

test('MessageEngine routes remote say from PORT and preserves the first delimiter only', async () => {
  const { engine, apiCalls } = createEngine();
  const sourceGroupId = 200001;
  const targetGroupId = '300001';
  const event = {
    group_id: sourceGroupId,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] remote ${targetGroupId} | say 你好 | 保留`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` remote ${targetGroupId} | say 你好 | 保留` } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[0]?.groupId, targetGroupId);
  assert.equal(apiCalls[0]?.payload, '你好 | 保留');
  assert.equal(apiCalls[1]?.groupId, String(sourceGroupId));
  assert.equal(apiCalls[1]?.payload, `已发送到 ${targetGroupId}`);
});

test('MessageEngine rejects malformed, unknown, empty, and legacy remote-shaped commands before state or chat', async () => {
  const { engine, apiCalls } = createEngine();
  const usage = '用法：@柯莱塔 remote <群号> | <命令>';
  const cases = [
    'remote 300001',
    'remote 1234 | 母on',
    'remote 300001 |',
    'remote 300001 | unknown',
    '母on 300001',
    'say你好 {300001}',
  ];

  for (const text of cases) {
    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 2,
      self_id: 3,
      raw_message: `[CQ:at,qq=3] ${text}`,
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    });
    assert.equal(apiCalls.at(-1)?.groupId, '1');
    assert.equal(apiCalls.at(-1)?.payload, usage);
    assert.equal(engine.stateStore.get('300001').motherModeEnabled, false);
  }
});

test('MessageEngine validates malformed remote before ignored-user and state branches', async () => {
  const stateStore = new GroupStateStore();
  stateStore.ignoreUser('1', '2');
  const { engine, apiCalls } = createEngine({ stateStore });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] remote nope',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' remote nope' } },
    ],
  });

  assert.deepEqual(apiCalls, [{ groupId: '1', payload: '用法：@柯莱塔 remote <群号> | <命令>' }]);
});

test('MessageEngine keeps a bare numeric say suffix local', async () => {
  const { engine, apiCalls } = createEngine();
  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] say你好 300001',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' say你好 300001' } },
    ],
  });

  assert.deepEqual(apiCalls, [{ groupId: '1', payload: '你好 300001' }]);
});

test('MessageEngine keeps local say behavior without target group', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] say你好',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' say你好' } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0]?.groupId, '1');
  assert.equal(apiCalls[0]?.payload, '你好');
});

test('MessageEngine toggles sphere lightning mode and scales confirmed strikes', async () => {
  const actionCalls = [];
  const { engine, apiCalls } = createEngine({
    random: () => 0.99,
    actionRegistry: {
      get(actionKey) {
        if (actionKey !== 'temporaryMute') {
          return null;
        }

        return {
          execute: async (args) => {
            actionCalls.push(args);
          },
        };
      },
    },
  });
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 球形闪电on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 球形闪电on' } },
    ],
  };
  const offEvent = {
    ...onEvent,
    raw_message: '[CQ:at,qq=3] 球形闪电off',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 球形闪电off' } },
    ],
  };
  const strikeEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '你好',
    message: [{ type: 'text', data: { text: '你好' } }],
  };

  engine.stateStore.arm('1', 'temporaryMute', '2', 20);

  await engine.handleGroupMessage(onEvent);
  assert.equal(apiCalls.at(-1)?.payload, '球形闪电模式已开启');
  assert.equal(engine.stateStore.get('1').sphereLightningModeEnabled, true);

  await engine.handleGroupMessage(strikeEvent);
  assert.equal(actionCalls.at(-1)?.durationSeconds, 20);
  assert.equal(apiCalls.at(-1)?.payload, '⚡⚡⚡⚡！！！！success（还剩19道闪电）');
  assert.equal(engine.stateStore.get('1').armedCount, 19);

  await engine.handleGroupMessage(offEvent);
  assert.equal(apiCalls.at(-1)?.payload, '球形闪电模式已关闭');
  assert.equal(engine.stateStore.get('1').sphereLightningModeEnabled, false);
});

test('MessageEngine sphere lightning upper bound falls back to remaining count under five', async () => {
  const actionCalls = [];
  const { engine, apiCalls } = createEngine({
    random: () => 0.99,
    actionRegistry: {
      get(actionKey) {
        if (actionKey !== 'temporaryMute') {
          return null;
        }

        return {
          execute: async (args) => {
            actionCalls.push(args);
          },
        };
      },
    },
  });
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 球形闪电on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 球形闪电on' } },
    ],
  };
  const strikeEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '你好',
    message: [{ type: 'text', data: { text: '你好' } }],
  };

  engine.stateStore.arm('1', 'temporaryMute', '2', 3);

  await engine.handleGroupMessage(onEvent);
  await engine.handleGroupMessage(strikeEvent);

  assert.equal(actionCalls.at(-1)?.durationSeconds, 15);
  assert.equal(apiCalls.at(-1)?.payload, '⚡⚡⚡！！！success（还剩2道闪电）');
});

test('MessageEngine appends exhausted remaining count after a final sphere lightning strike', async () => {
  const { engine, apiCalls } = createEngine({
    random: () => 0.99,
    actionRegistry: {
      get() {
        return { execute: async () => {} };
      },
    },
  });
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 球形闪电on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 球形闪电on' } },
    ],
  };
  const strikeEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '你好',
    message: [{ type: 'text', data: { text: '你好' } }],
  };

  engine.stateStore.arm('1', 'temporaryMute', '2', 1);

  await engine.handleGroupMessage(onEvent);
  await engine.handleGroupMessage(strikeEvent);

  assert.equal(apiCalls.at(-1)?.payload, '⚡！success（闪电已经用完了）');
  assert.equal(engine.stateStore.get('1').armedCount, 0);
  assert.equal(engine.stateStore.get('1').armed, false);
});

test('MessageEngine does not consume or append remaining count when sphere lightning action fails', async () => {
  const { engine, apiCalls } = createEngine({
    random: () => 0.99,
    actionRegistry: {
      get() {
        return {
          execute: async () => {
            throw new Error('action rejected');
          },
        };
      },
    },
  });
  const onEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 球形闪电on',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 球形闪电on' } },
    ],
  };
  const strikeEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '你好',
    message: [{ type: 'text', data: { text: '你好' } }],
  };

  engine.stateStore.arm('1', 'temporaryMute', '2', 20);

  await engine.handleGroupMessage(onEvent);
  await engine.handleGroupMessage(strikeEvent);

  assert.equal(apiCalls.at(-1)?.payload, 'failure');
  assert.equal(engine.stateStore.get('1').armedCount, 20);
  assert.equal(engine.stateStore.get('1').armed, true);
});

test('MessageEngine keeps normal lightning behavior when sphere mode is off', async () => {
  const actionCalls = [];
  const { engine, apiCalls } = createEngine({
    random: () => 0.99,
    actionRegistry: {
      get(actionKey) {
        if (actionKey !== 'temporaryMute') {
          return null;
        }

        return {
          execute: async (args) => {
            actionCalls.push(args);
          },
        };
      },
    },
  });
  const strikeEvent = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '你好',
    message: [{ type: 'text', data: { text: '你好' } }],
  };

  engine.stateStore.arm('1', 'temporaryMute', '2', 20);

  await engine.handleGroupMessage(strikeEvent);

  assert.equal(actionCalls.at(-1)?.durationSeconds, 5);
  assert.equal(apiCalls.at(-1)?.payload, 'success（还剩19道闪电）');
});

test('MessageEngine returns help overview for @bot help', async () => {
  const { engine, apiCalls } = createEngine();
  const event = {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] help',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' help' } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 1);
  assert.equal(typeof apiCalls[0]?.payload, 'string');
  assert.match(apiCalls[0].payload, /当前功能/);
  assert.match(apiCalls[0].payload, /全局管理员 QQ100001 @bot 启动 \/ 开启 \/ 重启 \/ 关机 \/ 关闭/);
  assert.match(apiCalls[0].payload, /柯莱塔ping/);
  assert.match(apiCalls[0].payload, /柯莱塔say <内容>/);
  assert.match(apiCalls[0].payload, /直接发送 挂N闪电/);
  assert.match(apiCalls[0].payload, /柯莱塔挂N闪电/);
  assert.match(apiCalls[0].payload, /@bot 问句on \/ 问句off/);
  assert.match(apiCalls[0].payload, /@bot <普通文本>：在配置聊天模型后进入群聊模式/);
  assert.match(apiCalls[0].payload, /全局管理员 @bot compact/);
  assert.match(apiCalls[0].payload, /全局管理员 @bot new/);
  assert.match(apiCalls[0].payload, /母on \/ 母off/);
  assert.match(apiCalls[0].payload, /给给\/拉拉/);
  assert.doesNotMatch(apiCalls[0].payload, /老公\/老婆/);
  assert.match(apiCalls[0].payload, /fuck<QQ号> \/ unfuck<QQ号>/);
  assert.match(apiCalls[0].payload, /管理员除外/);
  assert.match(apiCalls[0].payload, /球形闪电on \/ 球形闪电off/);
  assert.match(apiCalls[0].payload, /img2/);
  assert.match(apiCalls[0].payload, /柯莱塔挂闪电/);
  assert.match(apiCalls[0].payload, /自动：同图 \/ 同文连续重复会复读/);
  assert.doesNotMatch(apiCalls[0].payload, /remote/);
});

test('MessageEngine help in PORT includes remote syntax', async () => {
  const delays = [];
  const { engine, apiCalls } = createEngine({
    helpSegmentDelay: async (delayMs) => {
      delays.push(delayMs);
    },
  });
  const event = {
    group_id: 200001,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] help',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' help' } },
    ],
  };

  await engine.handleGroupMessage(event);

  assert.equal(apiCalls.length, 4);
  assert.deepEqual(delays, [1000, 1000, 1000]);
  assert.deepEqual(apiCalls.map(({ groupId }) => groupId), ['200001', '200001', '200001', '200001']);
  const help = apiCalls.map(({ payload }) => payload).join('\n');
  assert.match(apiCalls[0].payload, /^PORT 帮助 1\/4/);
  assert.match(apiCalls[1].payload, /^PORT 帮助 2\/4/);
  assert.match(apiCalls[2].payload, /^PORT 帮助 3\/4/);
  assert.match(apiCalls[3].payload, /^PORT 帮助 4\/4/);
  assert.doesNotMatch(apiCalls[0].payload, /remote/);
  assert.doesNotMatch(apiCalls[1].payload, /remote/);
  assert.doesNotMatch(apiCalls[2].payload, /remote/);
  assert.match(apiCalls[3].payload, /remote <群号> \| say <内容>/);
  assert.match(help, /？？<是非问句>/);
  assert.match(help, /rnd\[下限,上限\)fN/);
  assert.match(help, /对应 z/);
  assert.match(help, /柯莱塔ping/);
  assert.match(help, /柯莱塔say <内容>/);
  assert.match(help, /直接发送 挂N闪电/);
  assert.match(help, /柯莱塔挂N闪电/);
  assert.match(help, /自动：同图 \/ 同文连续重复会复读/);
  assert.doesNotMatch(help, /fujao|grok/i);
  assert.match(help, /role <临时角色> \/ @bot forget/);
  assert.match(help, /remote <群号> \| prompt <内容> \/ prompt clear/);
});

test('MessageEngine stops PORT help after a failed segment', async () => {
  const apiCalls = [];
  const apiClient = {
    async sendGroupMessage(groupId, payload) {
      apiCalls.push({ groupId, payload });
      if (apiCalls.length === 2) {
        throw new Error('send failed');
      }
    },
  };
  const { engine } = createEngine({
    apiClient,
    helpSegmentDelay: async () => {},
  });

  await assert.rejects(() => engine.handleGroupMessage({
    group_id: 200001,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] help',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' help' } },
    ],
  }), /send failed/);

  assert.equal(apiCalls.length, 2);
});

test('MessageEngine lets admin soft-close and soft-open the bot', async () => {
  const runtimeControl = createRuntimeControl(true);
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({
    runtimeControl,
    chatService,
  });

  const makeEvent = ({ userId, text }) => ({
    group_id: 1,
    user_id: userId,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  });

  await engine.handleGroupMessage(makeEvent({ userId: 100001, text: '关机' }));
  assert.equal(apiCalls.at(-1)?.payload, 'Bot 已关机');
  assert.equal(runtimeControl.value, false);

  const beforeIgnored = apiCalls.length;
  await engine.handleGroupMessage(makeEvent({ userId: 2, text: 'ping' }));
  assert.equal(apiCalls.length, beforeIgnored);

  await engine.handleGroupMessage(makeEvent({ userId: 100001, text: '启动' }));
  assert.equal(apiCalls.at(-1)?.payload, 'Bot 已开启');
  assert.equal(runtimeControl.value, true);

  await engine.handleGroupMessage(makeEvent({ userId: 2, text: 'ping' }));
  assert.equal(apiCalls.at(-1)?.payload, 'pong');
});

test('MessageEngine clears chat history on admin restart', async () => {
  const runtimeControl = createRuntimeControl(true);
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({
    runtimeControl,
    chatService,
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 100001,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 重启',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 重启' } },
    ],
  });

  assert.equal(apiCalls.at(-1)?.payload, 'Bot 已重启');
  assert.equal(runtimeControl.value, true);
  assert.equal(chatService.cleared, true);
});

test('MessageEngine toggles yes/no replies per group', async () => {
  const chatService = createChatServiceStub({ replies: ['chat answer', 'chat answer 2'] });
  const { engine, apiCalls } = createEngine({
    random: () => 0.25,
    chatService,
  });

  const makeEvent = (text) => ({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  });

  await engine.handleGroupMessage(makeEvent('问句on'));
  assert.equal(apiCalls.at(-1)?.payload, '问句随机应答已开启');
  assert.equal(engine.stateStore.get('1').yesNoReplyEnabled, true);

  const beforeChatFallback = apiCalls.length;
  await engine.handleGroupMessage(makeEvent('？？今天吃不吃滨寿司'));
  assert.equal(apiCalls.length, beforeChatFallback + 1);
  assert.match(apiCalls.at(-1)?.payload, /滨寿司/);
  assert.equal(chatService.completeCalls.length, 0);

  await engine.handleGroupMessage(makeEvent('？？今天吃不吃滨寿司？'));
  assert.match(apiCalls.at(-1)?.payload, /滨寿司/);

  await engine.handleGroupMessage(makeEvent('？？今天吃不吃滨寿司??'));
  assert.match(apiCalls.at(-1)?.payload, /滨寿司/);

  await engine.handleGroupMessage(makeEvent('？？'));
  assert.equal(apiCalls.at(-1)?.payload, '用法：@柯莱塔 ？？<是非问句>');

  await engine.handleGroupMessage(makeEvent('？？这是一个普通句子'));
  assert.equal(chatService.completeCalls.at(-1)?.at(-1)?.content, '这是一个普通句子');

  await engine.handleGroupMessage(makeEvent('？？？今天吃不吃滨寿司'));
  assert.equal(chatService.completeCalls.at(-1)?.at(-1)?.content, '？？？今天吃不吃滨寿司');

  await engine.handleGroupMessage(makeEvent('问句off'));
  assert.equal(apiCalls.at(-1)?.payload, '问句随机应答已关闭');
  assert.equal(engine.stateStore.get('1').yesNoReplyEnabled, false);

  await engine.handleGroupMessage(makeEvent('？？今天吃不吃滨寿司'));
  assert.equal(chatService.completeCalls.at(-1)?.at(-1)?.content, '今天吃不吃滨寿司');
});

test('MessageEngine applies exactly-two-leading-question-marker semantics', async () => {
  const chatService = createChatServiceStub({ replies: ['chat reply'] });
  const { engine, apiCalls } = createEngine({ chatService });
  const makeEvent = (text) => ({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  });

  await engine.handleGroupMessage(makeEvent('？？'));
  assert.deepEqual(apiCalls, [{ groupId: '1', payload: '用法：@柯莱塔 ？？<是非问句>' }]);
  assert.equal(chatService.completeCalls.length, 0);

  await engine.handleGroupMessage(makeEvent('？？普通问题'));
  await engine.handleGroupMessage(makeEvent('？？？普通问题'));
  await engine.handleGroupMessage(makeEvent('普通问题？'));

  assert.deepEqual(chatService.completeCalls.map((messages) => messages.at(-1)?.content), [
    '普通问题',
    '？？？普通问题',
    '普通问题？',
  ]);
  assert.deepEqual(apiCalls.map((call) => call.payload), [
    '用法：@柯莱塔 ？？<是非问句>',
    'chat reply',
    'chat reply',
    'chat reply',
  ]);
});

test('MessageEngine falls back to chat and preserves per-group transcript', async () => {
  const chatService = createChatServiceStub({ replies: ['第一轮回复', '第二轮回复'] });
  const { engine, apiCalls } = createEngine({
    chatService,
  });

  const makeEvent = (text) => ({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  });

  await engine.handleGroupMessage(makeEvent('你好'));
  assert.equal(apiCalls.at(-1)?.payload, '第一轮回复');
  assert.deepEqual(chatService.completeCalls[0], [{ role: 'user', content: '你好' }]);

  await engine.handleGroupMessage(makeEvent('你是谁'));
  assert.equal(apiCalls.at(-1)?.payload, '第二轮回复');
  assert.deepEqual(chatService.completeCalls[1], [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '第一轮回复' },
    { role: 'user', content: '你是谁' },
  ]);
  assert.deepEqual(chatService.getTranscript('1'), [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '第一轮回复' },
    { role: 'user', content: '你是谁' },
    { role: 'assistant', content: '第二轮回复' },
  ]);
});

function makeAtEvent(text) {
  return {
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: `[CQ:at,qq=3] ${text}`,
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  };
}

test('MessageEngine supports every rnd endpoint combination with exact discrete selection', async () => {
  for (const command of ['rnd[1,2]f2', 'rnd[1,2)f2', 'rnd(1,2]f2', 'rnd(1,2)f2']) {
    const { engine, apiCalls } = createEngine({ random: () => 0 });
    await engine.handleGroupMessage(makeAtEvent(command));
    assert.equal(apiCalls.at(-1)?.payload, command === 'rnd[1,2]f2' || command === 'rnd[1,2)f2' ? '1.00' : '1.01');
  }

  for (const command of ['rnd[1,2]z', 'rnd[1,2)z', 'rnd(1,2]z', 'rnd(1,2)z']) {
    const { engine, apiCalls } = createEngine({ random: () => 1 });
    await engine.handleGroupMessage(makeAtEvent(command));
    const expected = command === 'rnd(1,2)z'
      ? '随机区间无效：请检查边界、范围或格式'
      : command === 'rnd[1,2]z' || command === 'rnd(1,2]z' ? '2' : '1';
    assert.equal(apiCalls.at(-1)?.payload, expected);
  }
});

test('MessageEngine rnd uses exact bounds, signed decimals, and endpoint-safe formatting', async () => {
  const cases = [
    ['rnd[0,10)f2', 1, '9.99'],
    ['rnd(-2,10]z', 0, '-1'],
    ['rnd(-2,10]z', 1, '10'],
    ['rnd[ -.5, +.5 ]f2', 0, '-0.50'],
    ['rnd[ -.5, +.5 ]f2', 1, '0.50'],
  ];

  for (const [command, random, expected] of cases) {
    const { engine, apiCalls } = createEngine({ random: () => random });
    await engine.handleGroupMessage(makeAtEvent(command));
    assert.equal(apiCalls.at(-1)?.payload, expected);
    if (command.endsWith('f2')) assert.match(apiCalls.at(-1)?.payload, /^-?\d+\.\d{2}$/);
  }
});

test('MessageEngine rnd supports f10 precision with exact bracket endpoints', async () => {
  const cases = [
    ['rnd[0,1]f10', 0, '0.0000000000'],
    ['rnd[0,1]f10', 1, '1.0000000000'],
    ['rnd(0,1)f10', 0, '0.0000000001'],
    ['rnd(0,1)f10', 1, '0.9999999999'],
  ];

  for (const [command, random, expected] of cases) {
    const { engine, apiCalls } = createEngine({ random: () => random });
    await engine.handleGroupMessage(makeAtEvent(command));
    assert.equal(apiCalls.at(-1)?.payload, expected);
  }
});

test('MessageEngine rnd accepts the full signed 32-bit domain without candidate enumeration', async () => {
  for (const [command, random, expected] of [
    ['rnd[-2147483648,2147483647]f2', 0, '-2147483648.00'],
    ['rnd[-2147483648,2147483647]f2', 1, '2147483647.00'],
    ['rnd[-2147483648,2147483647]z', 0, '-2147483648'],
    ['rnd[-2147483648,2147483647]z', 1, '2147483647'],
  ]) {
    const { engine, apiCalls } = createEngine({ random: () => random });
    await engine.handleGroupMessage(makeAtEvent(command));
    assert.equal(apiCalls.at(-1)?.payload, expected);
  }
});

test('MessageEngine rnd rejects bounds outside the signed 32-bit integer domain', async () => {
  for (const command of ['rnd[-2147483649,0]f2', 'rnd[0,2147483648]f10']) {
    let sampled = false;
    const { engine, apiCalls } = createEngine({
      random: () => {
        sampled = true;
        return 0;
      },
    });

    await engine.handleGroupMessage(makeAtEvent(command));

    assert.equal(apiCalls.at(-1)?.payload, '随机区间无效：请检查边界、范围或格式');
    assert.equal(sampled, false);
  }
});

test('MessageEngine rejects malformed or unsafe rnd without chat fallback or sampling', async () => {
  const malformed = ['rnd [0,1]f2', 'rnd[0,1] f2', 'rnd[1.,2]f2', 'rnd[1e0,2]f2', 'rnd[0, 1]x'];
  for (const command of malformed) {
    let sampled = false;
    const chatService = createChatServiceStub();
    const { engine, apiCalls } = createEngine({
      random: () => { sampled = true; return 0; },
      chatService,
    });
    await engine.handleGroupMessage(makeAtEvent(command));
    assert.equal(apiCalls.at(-1)?.payload, '用法：@柯莱塔 rnd[下限,上限]fN / rnd[下限,上限)fN / rnd(下限,上限]fN / rnd(下限,上限)fN 或对应 z（fN 为 f0 到 f10）');
    assert.equal(sampled, false);
    assert.equal(chatService.completeCalls.length, 0);
  }

  for (const command of ['rnd[0,1000000000001]z', 'rnd[0,2147483648]f2', 'rnd[2,1]z', 'rnd[1,1)f2']) {
    let sampled = false;
    const { engine, apiCalls } = createEngine({
      random: () => { sampled = true; return 0; },
    });
    await engine.handleGroupMessage(makeAtEvent(command));
    assert.equal(apiCalls.at(-1)?.payload, '随机区间无效：请检查边界、范围或格式');
    assert.equal(sampled, false);
  }
});

test('MessageEngine contains an interrupted rnd sampler without escaping the handler', async () => {
  const { engine, apiCalls } = createEngine({
    random: () => {
      throw new Error('sampling interrupted');
    },
  });

  await assert.doesNotReject(() => engine.handleGroupMessage(makeAtEvent('rnd[0,1]f2')));
  assert.equal(apiCalls.at(-1)?.payload, '随机区间无效：请检查边界、范围或格式');
});

test('MessageEngine returns a short prompt for bare @bot mention', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({
    chatService,
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3]',
    message: [{ type: 'at', data: { qq: '3' } }],
  });

  assert.equal(apiCalls.at(-1)?.payload, '要我做什么？');
  assert.equal(chatService.completeCalls.length, 0);
});

test('MessageEngine does not enter chat for reply plus non-bot mention', async () => {
  const chatService = createChatServiceStub({ replies: ['chat reply'] });
  const { engine, apiCalls } = createEngine({
    chatService,
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:reply,id=999][CQ:at,qq=123456] 只是回复别人',
    message: [
      { type: 'reply', data: { id: '999' } },
      { type: 'at', data: { qq: '123456' } },
      { type: 'text', data: { text: ' 只是回复别人' } },
    ],
  });

  assert.equal(apiCalls.length, 0);
  assert.equal(chatService.completeCalls.length, 0);
});

test('MessageEngine still enters chat for reply plus bot mention', async () => {
  const chatService = createChatServiceStub({ replies: ['chat reply'] });
  const { engine, apiCalls } = createEngine({
    chatService,
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:reply,id=999][CQ:at,qq=3] 只是回复自己',
    message: [
      { type: 'reply', data: { id: '999' } },
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 只是回复自己' } },
    ],
  });

  assert.equal(apiCalls.at(-1)?.payload, 'chat reply');
  assert.equal(chatService.completeCalls.length, 1);
});

test('MessageEngine lets non-admin @bot 启动 fall through to chat', async () => {
  const chatService = createChatServiceStub({ replies: ['chat fallback'] });
  const { engine, apiCalls } = createEngine({
    chatService,
  });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] 启动',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' 启动' } },
    ],
  });

  assert.equal(apiCalls.at(-1)?.payload, 'chat fallback');
  assert.deepEqual(chatService.completeCalls[0], [{ role: 'user', content: '启动' }]);
});

test('MessageEngine lets the exact global admin compact memory regardless of group role', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService });
  chatService.recordUserMessage('1', '请记住这件事');
  chatService.recordAssistantMessage('1', '好的');

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: '100001',
    self_id: 3,
    raw_message: '[CQ:at,qq=3] compact',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' compact' } },
    ],
  });

  assert.deepEqual(chatService.compactCalls, ['1']);
  assert.equal(chatService.completeCalls.length, 0);
  assert.equal(apiCalls.at(-1)?.payload, '当前群记忆已压缩');
  assert.doesNotMatch(String(apiCalls.at(-1)?.payload), /hidden summary/);
});

test('MessageEngine handles @bot new as a per-group clear without calling the chat API', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService });
  chatService.recordUserMessage('1', '当前群');
  chatService.recordUserMessage('2', '其他群');

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 100001,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] new',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' new' } },
    ],
  });

  assert.deepEqual(chatService.clearCalls, ['1']);
  assert.deepEqual(chatService.getTranscript('1'), []);
  assert.deepEqual(chatService.getTranscript('2'), [{ role: 'user', content: '其他群' }]);
  assert.equal(chatService.completeCalls.length, 0);
  assert.equal(apiCalls.at(-1)?.payload, '当前群记忆已清空');
});

test('MessageEngine rejects exact compact/new for non-admin users without chat fallback or memory mutation', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService });
  chatService.recordUserMessage('1', '保留');

  for (const text of ['compact', 'new']) {
    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 2,
      self_id: 3,
      raw_message: `[CQ:at,qq=3] ${text}`,
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    });
  }

  assert.deepEqual(chatService.getTranscript('1'), [{ role: 'user', content: '保留' }]);
  assert.equal(chatService.clearCalls.length, 0);
  assert.equal(chatService.compactCalls.length, 0);
  assert.equal(chatService.completeCalls.length, 0);
  assert.deepEqual(apiCalls.map((call) => call.payload), [
    '只有全局管理员可以管理聊天记忆',
    '只有全局管理员可以管理聊天记忆',
  ]);
});

test('MessageEngine keeps compact/new behind disabled-bot gating', async () => {
  const runtimeControl = createRuntimeControl(false);
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ runtimeControl, chatService });
  chatService.recordUserMessage('1', '保留');

  for (const text of ['compact', 'new']) {
    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 100001,
      self_id: 3,
      raw_message: `[CQ:at,qq=3] ${text}`,
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    });
  }

  assert.equal(chatService.compactCalls.length, 0);
  assert.equal(chatService.clearCalls.length, 0);
  assert.equal(chatService.completeCalls.length, 0);
  assert.equal(apiCalls.length, 0);
  assert.deepEqual(chatService.getTranscript('1'), [{ role: 'user', content: '保留' }]);
});

test('MessageEngine reports empty and API-error compact outcomes without exposing summaries', async (t) => {
  await t.test('empty memory', async () => {
    const chatService = createChatServiceStub({ compactSummary: [] });
    const { engine, apiCalls } = createEngine({ chatService });

    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 100001,
      self_id: 3,
      raw_message: '[CQ:at,qq=3] compact',
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ' compact' } },
      ],
    });

    assert.equal(chatService.completeCalls.length, 0);
    assert.equal(apiCalls.at(-1)?.payload, '当前群没有可压缩的聊天记忆');
  });

  await t.test('API error is logged but not published', async () => {
    const errors = [];
    const chatService = createChatServiceStub({ compactError: new Error('provider unavailable secret=TOP_SECRET') });
    chatService.recordUserMessage('1', '原始记忆');
    const { engine, apiCalls } = createEngine({
      chatService,
      logger: {
        info() {},
        warn() {},
        debug() {},
        error(...args) {
          errors.push(args.join(' '));
        },
      },
    });

    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 100001,
      self_id: 3,
      raw_message: '[CQ:at,qq=3] compact',
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ' compact' } },
      ],
    });

    assert.deepEqual(chatService.getTranscript('1'), [{ role: 'user', content: '原始记忆' }]);
    assert.equal(apiCalls.at(-1)?.payload, '当前群记忆压缩失败，请稍后重试');
    assert.doesNotMatch(String(apiCalls.at(-1)?.payload), /TOP_SECRET|provider unavailable/);
    assert.match(errors.join('\n'), /TOP_SECRET/);
  });
});

test('MessageEngine routes only exact compact/new commands before chat fallback', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService });

  for (const text of ['compact now', 'newbie']) {
    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 100001,
      self_id: 3,
      raw_message: `[CQ:at,qq=3] ${text}`,
      message: [
        { type: 'at', data: { qq: '3' } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    });
  }

  assert.equal(chatService.compactCalls.length, 0);
  assert.equal(chatService.clearCalls.length, 0);
  assert.equal(chatService.completeCalls.length, 2);
  assert.equal(apiCalls.at(-1)?.payload, 'chat reply');
});

test('MessageEngine delegates cron creation before chat fallback', async () => {
  const calls = [];
  const cronScheduler = {
    async create(request) {
      calls.push(request);
      return { kind: 'created', id: 'cron-1', firstRunText: '2026-08-15 18:51' };
    },
  };
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService, cronScheduler });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] cron 202608151851 | 记得吃饭',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' cron 202608151851 | 记得吃饭' } },
    ],
  });

  assert.deepEqual(calls, [{
    groupId: '1',
    creatorUserId: '2',
    commandText: '202608151851 | 记得吃饭',
  }]);
  assert.equal(chatService.completeCalls.length, 0);
  assert.equal(apiCalls.at(-1)?.payload, '已建立提醒 cron-1，将于北京时间 2026-08-15 18:51 提醒');
});

test('MessageEngine delegates cron cancellation with creator identity', async () => {
  const calls = [];
  const cronScheduler = {
    async cancel(request) {
      calls.push(request);
      return { kind: 'cancelled', id: request.taskId };
    },
  };
  const { engine, apiCalls } = createEngine({ cronScheduler });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] cron cancel cron-1',
    message: [
      { type: 'at', data: { qq: '3' } },
      { type: 'text', data: { text: ' cron cancel cron-1' } },
    ],
  });

  assert.deepEqual(calls, [{ groupId: '1', requesterUserId: '2', taskId: 'cron-1' }]);
  assert.equal(apiCalls.at(-1)?.payload, '已取消提醒 cron-1');
});

test('MessageEngine returns detailed help without entering chat', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] help cron',
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' help cron' } }],
  });

  assert.match(String(apiCalls.at(-1)?.payload), /cron.*times.*broadcast/su);
  assert.equal(chatService.completeCalls.length, 0);
});

test('MessageEngine returns topic list for unknown detailed help', async () => {
  const chatService = createChatServiceStub();
  const { engine, apiCalls } = createEngine({ chatService });

  await engine.handleGroupMessage({
    group_id: 1,
    user_id: 2,
    self_id: 3,
    raw_message: '[CQ:at,qq=3] help unknown',
    message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' help unknown' } }],
  });

  assert.match(String(apiCalls.at(-1)?.payload), /可查询.*cron/su);
  assert.equal(chatService.completeCalls.length, 0);
});

test('MessageEngine resolves detailed help aliases', async () => {
  const { engine, apiCalls } = createEngine();
  for (const topic of ['role', 'forget', '启动', '关闭']) {
    await engine.handleGroupMessage({
      group_id: 1,
      user_id: 2,
      self_id: 3,
      raw_message: `[CQ:at,qq=3] help ${topic}`,
      message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ` help ${topic}` } }],
    });
  }

  assert.match(String(apiCalls[0]?.payload), /role/u);
  assert.equal(apiCalls[0]?.payload, apiCalls[1]?.payload);
  assert.match(String(apiCalls[2]?.payload), /管理员 QQ100001/u);
  assert.equal(apiCalls[2]?.payload, apiCalls[3]?.payload);
});
