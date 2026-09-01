import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  getNewHistoryMessages,
  normalizeHistoryMessage,
  OneBotClient,
} from './onebot-client.js';

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

class FakeSocket extends EventEmitter {
  static OPEN = 1;

  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit('open');
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) {
      return;
    }

    this.readyState = FakeSocket.CLOSED;
    this.emit('close');
  }

  send(payload) {
    this.sent.push(payload);
  }
}

function createSocketFactory() {
  const sockets = [];
  return {
    sockets,
    factory: class extends FakeSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    },
  };
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
  };
}

async function connectSockets(client, sockets) {
  const connecting = client.connect();
  sockets[0].open();
  sockets[1].open();
  await connecting;
}

test('history fallback returns unseen messages in sequence order', () => {
  const messages = [
    { message_seq: 12, raw_message: 'later' },
    { message_seq: 10, raw_message: 'already seen' },
    { message_seq: 11, raw_message: 'newer' },
  ];

  const result = getNewHistoryMessages(messages, 10);

  assert.deepEqual(result.map((message) => message.message_seq), [11, 12]);
});

test('history fallback normalizes a history record into a group message event', () => {
  const historyMessage = {
    message_type: 'group',
    group_id: 200001,
    user_id: 100001,
    message_seq: 1017,
    raw_message: '[CQ:at,qq=400001] ping',
  };

  const result = normalizeHistoryMessage(historyMessage, 400001);

  assert.deepEqual(result, {
    ...historyMessage,
    post_type: 'message',
    self_id: 400001,
  });
});

test('OneBotClient keeps reconnect disabled by default', async () => {
  const { factory, sockets } = createSocketFactory();
  const timers = createTimerHarness();
  const client = new OneBotClient({
    eventUrl: 'ws://event.test/events',
    apiUrl: 'ws://api.test/api',
    logger,
    webSocketFactory: factory,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  await connectSockets(client, sockets);
  sockets[0].close();

  assert.equal(timers.timers.length, 0);
  assert.equal(client.eventSocket, null);
  assert.equal(client.apiSocket, null);
});

test('OneBotClient reconnects one coordinated socket pair with one handler per socket', async () => {
  const { factory, sockets } = createSocketFactory();
  const timers = createTimerHarness();
  const client = new OneBotClient({
    eventUrl: 'ws://event.test/events',
    apiUrl: 'ws://api.test/api',
    logger,
    autoReconnect: true,
    webSocketFactory: factory,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const received = [];
  client.onGroupMessage(async (event) => {
    received.push(event.message_seq);
  });

  await connectSockets(client, sockets);
  assert.equal(sockets[0].listenerCount('message'), 1);
  assert.equal(sockets[1].listenerCount('message'), 1);
  await client.connect();
  assert.equal(sockets[0].listenerCount('message'), 1);

  sockets[0].emit('message', JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    message_seq: 10,
  }));
  assert.deepEqual(received, [10]);

  sockets[0].close();
  assert.deepEqual(timers.timers.map((timer) => timer.delay), [1000]);
  timers.timers[0].callback();
  await Promise.resolve();
  assert.equal(sockets.length, 4);
  sockets[2].open();
  sockets[3].open();
  await client.connectPromise;

  sockets[0].emit('message', JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    message_seq: 11,
  }));
  sockets[2].emit('message', JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    message_seq: 11,
  }));
  assert.deepEqual(received, [10, 11]);
  assert.equal(sockets[2].listenerCount('message'), 1);
  assert.equal(timers.timers.length, 1);
});

test('OneBotClient uses bounded exponential reconnect delays and resets after success', async () => {
  const { factory, sockets } = createSocketFactory();
  const timers = createTimerHarness();
  const client = new OneBotClient({
    eventUrl: 'ws://event.test/events',
    apiUrl: 'ws://api.test/api',
    logger,
    autoReconnect: true,
    webSocketFactory: factory,
    reconnectBaseDelayMs: 1000,
    reconnectMaxDelayMs: 2500,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  await connectSockets(client, sockets);
  sockets[0].close();
  assert.equal(timers.timers[0].delay, 1000);
  timers.timers[0].callback();
  await Promise.resolve();
  sockets[2].emit('error', new Error('reconnect failed'));
  sockets[3].emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.timers[1].delay, 2000);
  timers.timers[1].callback();
  await Promise.resolve();
  sockets[4].emit('error', new Error('second reconnect failed'));
  sockets[5].emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.timers[2].delay, 2500);
  timers.timers[2].callback();
  await Promise.resolve();
  sockets[6].open();
  sockets[7].open();
  await client.connectPromise;

  sockets[6].close();
  assert.equal(timers.timers[3].delay, 1000);
});

test('OneBotClient stop is idempotent and cleans timers, pending calls, and sockets', async () => {
  const { factory, sockets } = createSocketFactory();
  const timers = createTimerHarness();
  const client = new OneBotClient({
    eventUrl: 'ws://event.test/events',
    apiUrl: 'ws://api.test/api',
    logger,
    autoReconnect: true,
    webSocketFactory: factory,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  await connectSockets(client, sockets);
  client.scheduleHistoryPoll();
  const pending = client.call('get_login_info', {});
  sockets[0].close();

  client.stop();
  client.stop();
  await assert.rejects(pending, /OneBot client stopped/);

  assert.equal(sockets[0].readyState, FakeSocket.CLOSED);
  assert.equal(sockets[1].readyState, FakeSocket.CLOSED);
  assert.equal(client.eventSocket, null);
  assert.equal(client.apiSocket, null);
  assert.equal(client.pendingRequests.size, 0);
  assert.equal(timers.timers.length, 3);
  assert.equal(timers.timers.every((timer) => timer.cleared), true);
});

test('OneBotClient stop prevents an in-flight history poll from rescheduling', async () => {
  const { factory, sockets } = createSocketFactory();
  const timers = createTimerHarness();
  const client = new OneBotClient({
    eventUrl: 'ws://event.test/events',
    apiUrl: 'ws://api.test/api',
    logger,
    webSocketFactory: factory,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  await connectSockets(client, sockets);
  client.scheduleHistoryPoll();
  const polling = timers.timers[0].callback();
  client.stop();
  await polling;

  assert.equal(timers.timers.length, 2);
  assert.equal(timers.timers[1].cleared, true);
  assert.equal(client.historyPollTimer, null);
});
