import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNewHistoryMessages,
  normalizeHistoryMessage,
} from './onebot-client.js';

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
