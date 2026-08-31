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
  const groupRulesFile = resolveRulesFile(requireEnv('GROUP_RULES_FILE'));
  const raw = fs.readFileSync(groupRulesFile, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    napcat: {
      eventUrl: requireEnv('NAPCAT_WS_URL'),
      apiUrl: normalizeNapcatApiUrl(requireEnv('NAPCAT_API_WS_URL')),
      accessToken: process.env.SNOWLUMA_ACCESS_TOKEN ?? '',
    },
    logLevel: process.env.LOG_LEVEL ?? 'info',
    groupRulesFile,
    defaultRule: parsed.defaultRule ?? {},
    groupRules: parsed.groups ?? {},
  };
}
