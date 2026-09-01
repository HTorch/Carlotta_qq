import fs from 'node:fs';
import path from 'node:path';

function normalizeNapcatApiUrl(rawUrl) {
  const url = new URL(rawUrl);

  if ((url.hostname === '127.0.0.1' || url.hostname === 'example.invalid')
    && url.port === '3001' && /^\/api\/?$/u.test(url.pathname)) {
    url.pathname = '/';
  }

  return url.toString();
}

function requireWebSocketUrl(name) {
  const value = requireEnv(name);

  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error(`Invalid ${name}: expected a valid ws:// or wss:// URL`);
  }

  return value;
}

function validateGroupRules(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid group rules: root must be an object');
  }

  for (const [name, value] of [['defaultRule', parsed.defaultRule], ['groups', parsed.groups]]) {
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`Invalid group rules: ${name} must be an object`);
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolveRulesFile(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(process.cwd(), filePath);
}

export function loadConfig() {
  const eventUrl = requireWebSocketUrl('NAPCAT_WS_URL');
  const apiUrl = requireWebSocketUrl('NAPCAT_API_WS_URL');
  const groupRulesFile = resolveRulesFile(requireEnv('GROUP_RULES_FILE'));
  const raw = fs.readFileSync(groupRulesFile, 'utf8');
  const parsed = JSON.parse(raw);
  validateGroupRules(parsed);

  return {
    napcat: {
      eventUrl,
      apiUrl: normalizeNapcatApiUrl(apiUrl),
      accessToken: process.env.SNOWLUMA_ACCESS_TOKEN ?? '',
      autoReconnect: process.env.ONEBOT_AUTO_RECONNECT === 'true',
    },
    logLevel: process.env.LOG_LEVEL ?? 'info',
    groupRulesFile,
    defaultRule: parsed.defaultRule ?? {},
    groupRules: parsed.groups ?? {},
  };
}
