import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const HISTORY_POLL_INTERVAL_MS = 5000;
const HISTORY_BATCH_SIZE = 50;
const MAX_SEEN_MESSAGE_KEYS = 5000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

function createUrlWithToken(rawUrl, token) {
  if (!token) {
    return rawUrl;
  }

  const url = new URL(rawUrl);
  url.searchParams.set('access_token', token);
  return url.toString();
}

export function redactUrlForLog(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid URL redacted]';
  }
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
  constructor({
    eventUrl,
    apiUrl,
    accessToken,
    logger,
    autoReconnect = false,
    webSocketFactory = WebSocket,
    reconnectBaseDelayMs = RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs = RECONNECT_MAX_DELAY_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    this.eventUrl = createUrlWithToken(eventUrl, accessToken);
    this.apiUrl = createUrlWithToken(apiUrl, accessToken);
    this.logger = logger;
    this.autoReconnect = autoReconnect;
    this.webSocketFactory = webSocketFactory;
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.eventSocket = null;
    this.apiSocket = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.openingSockets = new Set();
    this.messageHandlers = [];
    this.pendingRequests = new Map();
    this.historyPollTimer = null;
    this.historyPolling = false;
    this.historyCursors = new Map();
    this.seenMessageKeys = new Set();
    this.selfId = null;
    this.stopped = false;
  }

  async connect() {
    if (this.stopped) {
      throw new Error('OneBot client is stopped');
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.hasOpenSocketPair()) {
      return;
    }

    this.clearReconnectTimer();
    const connectPromise = this.openSocketPair();
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
      this.reconnectAttempt = 0;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  onGroupMessage(handler) {
    this.messageHandlers.push(handler);
  }

  async startHistoryPolling() {
    if (this.stopped || this.historyPollTimer || this.historyPolling) {
      return;
    }

    try {
      const response = await this.call('get_login_info', {});
      this.selfId = response.data?.user_id ?? null;
    } catch (error) {
      this.logger.warn('History fallback could not resolve self id:', error.message);
    }

    if (this.stopped) {
      return;
    }

    await this.pollHistory();
    if (!this.stopped) {
      this.scheduleHistoryPoll();
    }
  }

  stopHistoryPolling() {
    if (!this.historyPollTimer) {
      return;
    }

    this.clearTimeoutFn(this.historyPollTimer);
    this.historyPollTimer = null;
  }

  stop() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearReconnectTimer();
    this.stopHistoryPolling();

    const stopError = new Error('OneBot client stopped');
    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const pending of pendingRequests) {
      pending.reject(stopError);
    }

    const sockets = new Set([
      ...this.openingSockets,
      this.eventSocket,
      this.apiSocket,
    ]);
    this.openingSockets.clear();
    this.eventSocket = null;
    this.apiSocket = null;
    for (const socket of sockets) {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
    }
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

    const socket = this.apiSocket;
    return new Promise((resolve, reject) => {
      const timeout = this.setTimeoutFn(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`OneBot API timeout for action ${action}`));
      }, 10000);

      this.pendingRequests.set(echo, {
        resolve: (response) => {
          this.clearTimeoutFn(timeout);
          resolve(response);
        },
        reject: (error) => {
          this.clearTimeoutFn(timeout);
          reject(error);
        },
      });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pendingRequests.delete(echo);
        this.clearTimeoutFn(timeout);
        reject(error);
      }
    });
  }

  async openSocket(url, socketName) {
    return new Promise((resolve, reject) => {
      const socket = new this.webSocketFactory(url);
      this.openingSockets.add(socket);
      let settled = false;
      const cleanup = () => {
        this.openingSockets.delete(socket);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };
      const onError = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.logger.error(`${socketName} socket error while connecting to ${redactUrlForLog(url)}`);
        reject(error);
      };
      const onClose = () => {
        onError(new Error(`${socketName} socket closed before connecting`));
      };

      socket.once('open', () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        if (this.stopped) {
          socket.close();
          reject(new Error('OneBot client stopped'));
          return;
        }
        this.logger.info(`Connected ${socketName} socket: ${redactUrlForLog(url)}`);
        resolve(socket);
      });
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  async openSocketPair() {
    const results = await Promise.allSettled([
      this.openSocket(this.eventUrl, 'event'),
      this.openSocket(this.apiUrl, 'api'),
    ]);
    const openedSockets = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected || this.stopped) {
      for (const socket of openedSockets) {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      }
      throw rejected?.reason ?? new Error('OneBot client stopped');
    }

    const [eventSocket, apiSocket] = openedSockets;
    if (eventSocket.readyState !== WebSocket.OPEN || apiSocket.readyState !== WebSocket.OPEN) {
      eventSocket.close();
      apiSocket.close();
      throw new Error('OneBot socket pair closed before connection completed');
    }
    this.eventSocket = eventSocket;
    this.apiSocket = apiSocket;
    this.attachSocketHandlers(eventSocket, 'event');
    this.attachSocketHandlers(apiSocket, 'api');
  }

  attachSocketHandlers(socket, socketName) {
    socket.on('error', (error) => {
      this.logger.warn(`${socketName} socket error:`, error.message);
    });
    socket.once('close', () => {
      this.handleSocketClose(socket, socketName);
    });

    if (socketName === 'event') {
      socket.on('message', (raw) => {
        if (this.eventSocket !== socket) {
          return;
        }

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
      return;
    }

    socket.on('message', (raw) => {
      if (this.apiSocket !== socket) {
        return;
      }

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

  hasOpenSocketPair() {
    return this.eventSocket?.readyState === WebSocket.OPEN
      && this.apiSocket?.readyState === WebSocket.OPEN;
  }

  handleSocketClose(socket, socketName) {
    if (this.eventSocket !== socket && this.apiSocket !== socket) {
      return;
    }

    this.logger.warn(`${socketName} socket closed`);
    const peerSocket = socket === this.eventSocket ? this.apiSocket : this.eventSocket;
    this.eventSocket = null;
    this.apiSocket = null;

    if (peerSocket && peerSocket.readyState !== WebSocket.CLOSED) {
      peerSocket.close();
    }
    if (this.autoReconnect && !this.stopped) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped || !this.autoReconnect || this.reconnectTimer || this.connectPromise) {
      return;
    }

    const delay = Math.min(
      this.reconnectBaseDelayMs * (2 ** this.reconnectAttempt),
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    const token = {};
    const handle = this.setTimeoutFn(() => {
      if (this.reconnectTimer?.token !== token) {
        return;
      }

      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.logger.warn('OneBot reconnect failed:', error.message);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer = { handle, token };
    handle.unref?.();
    this.logger.warn(`Scheduling OneBot reconnect in ${delay}ms`);
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }

    this.clearTimeoutFn(this.reconnectTimer.handle);
    this.reconnectTimer = null;
  }

  scheduleHistoryPoll() {
    if (this.stopped) {
      return;
    }

    this.historyPollTimer = this.setTimeoutFn(async () => {
      this.historyPollTimer = null;
      await this.pollHistory();
      if (!this.stopped) {
        this.scheduleHistoryPoll();
      }
    }, HISTORY_POLL_INTERVAL_MS);
    this.historyPollTimer.unref?.();
  }

  async pollHistory() {
    if (this.stopped || !this.apiSocket || this.apiSocket.readyState !== WebSocket.OPEN || this.historyPolling) {
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
