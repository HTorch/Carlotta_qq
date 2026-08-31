import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHAT_API_TIMEOUT_MS = 120000;
const DEFAULT_MODEL = 'gpt-4o-mini';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(MODULE_DIR, '../.env');
const MAX_TRANSCRIPT_MESSAGES = 16;
const SUMMARY_INSTRUCTION = 'Summarize the following chat transcript into a concise memory for future replies. Return only the summary.';

function readEnvFileKey(name) {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (key !== name) {
        continue;
      }

      return trimmed.slice(separatorIndex + 1).trim();
    }
  } catch {
    return '';
  }

  return '';
}

function readConfigValue(name) {
  return process.env[name] || readEnvFileKey(name);
}

function normalizeBaseUrl(rawUrl) {
  return String(rawUrl ?? '').trim().replace(/\/+$/, '');
}

function getApiKey() {
  const apiKey = readConfigValue('CHAT_API_KEY');
  if (!apiKey || apiKey === 'replace_me') {
    throw new Error('Missing CHAT_API_KEY（请在 .env 里填写）');
  }

  return apiKey;
}

function getBaseUrl() {
  const baseUrl = normalizeBaseUrl(readConfigValue('CHAT_API_BASE_URL'));
  if (!baseUrl || baseUrl === 'replace_me') {
    throw new Error('Missing CHAT_API_BASE_URL（请在 .env 里填写）');
  }

  return baseUrl;
}

function getModel() {
  return readConfigValue('CHAT_MODEL') || DEFAULT_MODEL;
}

function normalizeRole(role) {
  if (role === 'assistant' || role === 'system') {
    return role;
  }

  return 'user';
}

function normalizeContent(content) {
  return String(content ?? '').trim();
}

function parseMessageContent(responsePayload) {
  const firstChoice = Array.isArray(responsePayload?.choices) ? responsePayload.choices[0] : null;
  const directContent = firstChoice?.message?.content;
  if (typeof directContent === 'string' && directContent.trim()) {
    return directContent.trim();
  }

  if (typeof firstChoice?.text === 'string' && firstChoice.text.trim()) {
    return firstChoice.text.trim();
  }

  if (typeof responsePayload?.message?.content === 'string' && responsePayload.message.content.trim()) {
    return responsePayload.message.content.trim();
  }

  if (typeof responsePayload?.output_text === 'string' && responsePayload.output_text.trim()) {
    return responsePayload.output_text.trim();
  }

  return '';
}

async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHAT_API_TIMEOUT_MS);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message = String(error?.message ?? error ?? '');
    if (error?.name === 'AbortError' || /aborted|timed out/i.test(message)) {
      throw new Error(`Chat API request timed out after ${CHAT_API_TIMEOUT_MS / 1000}s`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readErrorMessage(response) {
  const text = await response.text();
  if (!text.trim()) {
    return `Chat API HTTP ${response.status}`;
  }

  try {
    const payload = JSON.parse(text);
    return payload?.error?.message || payload?.message || `Chat API HTTP ${response.status}`;
  } catch {
    return text.slice(0, 500);
  }
}

export class ChatService {
  constructor({ maxTranscriptMessages = MAX_TRANSCRIPT_MESSAGES } = {}) {
    this.maxTranscriptMessages = maxTranscriptMessages;
    this.transcriptsByGroup = new Map();
  }

  getBaseUrl() {
    return getBaseUrl();
  }

  getApiKey() {
    return getApiKey();
  }

  getModel() {
    return getModel();
  }

  getTranscript(groupId) {
    return [...(this.transcriptsByGroup.get(String(groupId)) ?? [])];
  }

  appendMessage(groupId, role, content) {
    const normalizedContent = normalizeContent(content);
    if (!normalizedContent) {
      return this.getTranscript(groupId);
    }

    const normalizedRole = normalizeRole(role);
    if (normalizedRole === 'system') {
      return this.getTranscript(groupId);
    }

    const key = String(groupId);
    const nextTranscript = [...(this.transcriptsByGroup.get(key) ?? []), { role: normalizedRole, content: normalizedContent }];
    const maxMessages = Math.max(2, this.maxTranscriptMessages);
    while (nextTranscript.length > maxMessages) {
      nextTranscript.shift();
    }

    this.transcriptsByGroup.set(key, nextTranscript);
    return [...nextTranscript];
  }

  recordUserMessage(groupId, content) {
    return this.appendMessage(groupId, 'user', content);
  }

  recordAssistantMessage(groupId, content) {
    return this.appendMessage(groupId, 'assistant', content);
  }

  clearTranscript(groupId) {
    this.transcriptsByGroup.delete(String(groupId));
  }

  async compactTranscript(groupId, { prompt = null, role = null } = {}) {
    const key = String(groupId);
    const transcript = this.getTranscript(key);
    if (transcript.length === 0) {
      return [];
    }

    const summary = await this.completeChat({
      messages: [
        ...(prompt ? [{ role: 'system', content: prompt }] : []),
        ...(role ? [{ role: 'system', content: role }] : []),
        { role: 'system', content: SUMMARY_INSTRUCTION },
        ...transcript,
      ],
    });
    const compactedTranscript = [{ role: 'system', content: summary }];
    this.transcriptsByGroup.set(key, compactedTranscript);
    return [...compactedTranscript];
  }

  clearAllTranscripts() {
    this.transcriptsByGroup.clear();
  }

  async completeChat({ messages, baseUrl = this.getBaseUrl(), apiKey = this.getApiKey(), model = this.getModel() }) {
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available in this runtime');
    }

    const normalizedMessages = Array.isArray(messages)
      ? messages
        .map((message) => ({
          role: normalizeRole(message?.role),
          content: normalizeContent(message?.content),
        }))
        .filter((message) => message.content)
      : [];

    if (normalizedMessages.length === 0) {
      throw new Error('Missing chat messages');
    }

    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: normalizedMessages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error('Chat API returned empty response');
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Chat API returned non-JSON success response: ${text.slice(0, 200)}`);
    }

    const content = parseMessageContent(payload);
    if (!content) {
      throw new Error('Chat API returned unsupported payload');
    }

    return content;
  }
}
