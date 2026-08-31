import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const HISTORY_POLL_INTERVAL_MS = 5000;
const HISTORY_BATCH_SIZE = 50;
const MAX_SEEN_MESSAGE_KEYS = 5000;

function createUrlWithToken(rawUrl, token) {
  if (!token) {
    return rawUrl;
  }

  const url = new URL(rawUrl);
  url.searchParams.set('access_token', token);
  return url.toString();
}

export function getNewHistoryMessages(messages, cursor) {
  return messages
    .filter((message) => Number.isSafeInteger(Number(message.message_seq)) && Number(message.message_seq) > cursor)
    .sort((left, right) => Number(left.message_seq) - Number(right.message_seq));
}

export function normalizeHistoryMessage(message, selfId) {
  return {
    ...message,
    post_type: 'message',
    self_id: selfId,
  };
}

export class OneBotClient {
  constructor({ eventUrl, apiUrl, accessToken, logger }) {
    this.eventUrl = createUrlWithToken(eventUrl, accessToken);
    this.apiUrl = createUrlWithToken(apiUrl, accessToken);
    this.logger = logger;
    this.eventSocket = null;
    this.apiSocket = null;
    this.messageHandlers = [];
    this.pendingRequests = new Map();
    this.historyPollTimer = null;
    this.historyPolling = false;
    this.historyCursors = new Map();
    this.seenMessageKeys = new Set();
    this.selfId = null;
  }

  async connect() {
    this.eventSocket = await this.openSocket(this.eventUrl, 'event');
    this.apiSocket = await this.openSocket(this.apiUrl, 'api');

    this.eventSocket.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event?.post_type === 'message' || event?.post_type === 'message_sent') {
          this.logger.debug('OneBot message event received:', JSON.stringify({
            post_type: event.post_type,
            message_type: event.message_type,
            sub_type: event.sub_type,
            group_id: event.group_id,
            user_id: event.user_id,
            raw_message: event.raw_message,
          }));
        }
        this.routeEvent(event);
      } catch (error) {
        this.logger.warn('Failed to parse event payload:', error.message);
      }
    });

    this.apiSocket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        const pending = this.pendingRequests.get(payload.echo);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(payload.echo);
        if (payload.status === 'ok') {
          pending.resolve(payload);
          return;
        }

        pending.reject(new Error(payload.wording ?? payload.msg ?? 'OneBot API call failed'));
      } catch (error) {
        this.logger.warn('Failed to parse API payload:', error.message);
      }
    });
  }

  onGroupMessage(handler) {
    this.messageHandlers.push(handler);
  }

  async startHistoryPolling() {
    if (this.historyPollTimer || this.historyPolling) {
      return;
    }

    try {
      const response = await this.call('get_login_info', {});
      this.selfId = response.data?.user_id ?? null;
    } catch (error) {
      this.logger.warn('History fallback could not resolve self id:', error.message);
    }

    await this.pollHistory();
    this.scheduleHistoryPoll();
  }

  stopHistoryPolling() {
    if (!this.historyPollTimer) {
      return;
    }

    clearTimeout(this.historyPollTimer);
    this.historyPollTimer = null;
  }

  async sendGroupMessage(groupId, message) {
    return this.call('send_group_msg', {
      group_id: Number(groupId),
      message,
    });
  }

  async call(action, params) {
    if (!this.apiSocket || this.apiSocket.readyState !== WebSocket.OPEN) {
      throw new Error('OneBot API socket is not connected');
    }

    const echo = randomUUID();
    const payload = { action, params, echo };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`OneBot API timeout for action ${action}`));
      }, 10000);

      this.pendingRequests.set(echo, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.apiSocket.send(JSON.stringify(payload));
    });
  }

  async openSocket(url, socketName) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once('open', () => {
        this.logger.info(`Connected ${socketName} socket: ${url}`);
        resolve(socket);
      });
      socket.once('error', reject);
      socket.on('close', () => {
        this.logger.warn(`${socketName} socket closed`);
      });
    });
  }

  scheduleHistoryPoll() {
    this.historyPollTimer = setTimeout(async () => {
      this.historyPollTimer = null;
      await this.pollHistory();
      this.scheduleHistoryPoll();
    }, HISTORY_POLL_INTERVAL_MS);
    this.historyPollTimer.unref?.();
  }

  async pollHistory() {
    if (!this.apiSocket || this.apiSocket.readyState !== WebSocket.OPEN || this.historyPolling) {
      return;
    }

    this.historyPolling = true;
    try {
      const response = await this.call('get_group_list', {});
      const groups = Array.isArray(response.data) ? response.data : [];
      for (const group of groups) {
        const groupId = Number(group.group_id);
        if (!Number.isSafeInteger(groupId)) {
          continue;
        }

        await this.pollGroupHistory(groupId);
      }
    } catch (error) {
      this.logger.warn('History fallback poll failed:', error.message);
    } finally {
      this.historyPolling = false;
    }
  }

  async pollGroupHistory(groupId) {
    const response = await this.call('get_group_msg_history', {
      group_id: groupId,
      count: HISTORY_BATCH_SIZE,
    });
    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    const sequences = messages.map((message) => Number(message.message_seq)).filter(Number.isSafeInteger);
    if (sequences.length === 0) {
      return;
    }

    const newestSequence = Math.max(...sequences);
    const cursor = this.historyCursors.get(groupId);
    if (cursor === undefined) {
      this.historyCursors.set(groupId, newestSequence);
      return;
    }

    for (const message of getNewHistoryMessages(messages, cursor)) {
      const event = normalizeHistoryMessage(message, this.selfId);
      this.routeEvent(event);
    }

    this.historyCursors.set(groupId, Math.max(cursor, newestSequence));
  }

  routeEvent(event) {
    const isGroupMessage = event.post_type === 'message' || event.post_type === 'message_sent';
    if (!isGroupMessage || event.message_type !== 'group') {
      return;
    }

    const messageKey = this.getMessageKey(event);
    if (messageKey && this.seenMessageKeys.has(messageKey)) {
      return;
    }
    if (messageKey) {
      this.rememberMessageKey(messageKey);
    }

    for (const handler of this.messageHandlers) {
      handler(event).catch((error) => {
        this.logger.error('Group message handler failed:', error.message);
      });
    }
  }

  getMessageKey(event) {
    const sequence = event.message_seq ?? event.message_id;
    if (sequence === undefined || event.group_id === undefined) {
      return null;
    }

    return `${event.group_id}:${sequence}`;
  }

  rememberMessageKey(messageKey) {
    this.seenMessageKeys.add(messageKey);
    if (this.seenMessageKeys.size <= MAX_SEEN_MESSAGE_KEYS) {
      return;
    }

    const oldestKey = this.seenMessageKeys.values().next().value;
    this.seenMessageKeys.delete(oldestKey);
  }
}
