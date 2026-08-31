const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const PERIOD_UNITS = new Map([
  ['m', MINUTE_MS],
  ['h', HOUR_MS],
  ['d', 24 * HOUR_MS],
  ['w', 7 * 24 * HOUR_MS],
]);

function rejected(message) {
  return { kind: 'rejected', message };
}

function getMinuteTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / MINUTE_MS) * MINUTE_MS : null;
}

function parseShanghaiTimestamp(value) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/u);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const timestamp = Date.UTC(year, month - 1, day, hour - 8, minute);
  const local = new Date(timestamp + SHANGHAI_OFFSET_MS);

  if (local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute) {
    return null;
  }

  return timestamp;
}

function parsePeriod(value) {
  const match = String(value).match(/^(\d+)([mhdw])$/u);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unitMs = PERIOD_UNITS.get(match[2]);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !unitMs) {
    return null;
  }

  const intervalMs = amount * unitMs;
  return Number.isSafeInteger(intervalMs) ? intervalMs : null;
}

function parseRunCount(value) {
  if (!/^\d+$/u.test(String(value))) {
    return null;
  }

  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function getRunCountUntil(firstRunAt, expiresAt, intervalMs) {
  return Math.floor((expiresAt - firstRunAt) / intervalMs) + 1;
}

export function formatBeijingMinute(timestamp) {
  const local = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const values = [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
  ];
  const [year, month, day, hour, minute] = values;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function getFirstFutureRun({ firstRunAt, intervalMs, now }) {
  const nowTimestamp = Number(now);
  if (!Number.isFinite(firstRunAt) || !Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(nowTimestamp)) {
    return null;
  }

  if (firstRunAt > nowTimestamp) {
    return firstRunAt;
  }

  const skippedRuns = Math.floor((nowTimestamp - firstRunAt) / intervalMs) + 1;
  return firstRunAt + skippedRuns * intervalMs;
}

export function parseCronSchedule(commandText, { now }) {
  const currentMinute = getMinuteTimestamp(now);
  if (currentMinute === null) {
    return rejected('cron 当前时间无效');
  }

  const delimiter = String(commandText).indexOf('|');
  if (delimiter === -1) {
    return rejected('cron 缺少正文分隔符 |');
  }

  const scheduleText = String(commandText).slice(0, delimiter).trim();
  const content = String(commandText).slice(delimiter + 1);
  if (!content.trim()) {
    return rejected('cron 正文不能为空');
  }

  const tokens = scheduleText ? scheduleText.split(/\s+/u) : [];
  let index = 0;
  let firstRunAt = currentMinute;
  if (/^\d/u.test(tokens[0] ?? '')) {
    firstRunAt = parseShanghaiTimestamp(tokens[index]);
    if (firstRunAt === null) {
      return rejected('cron 时间格式应为 YYYYMMDDHHmm');
    }
    if (firstRunAt < currentMinute) {
      return rejected('cron 首次时间不能早于当前分钟');
    }
    index += 1;
  }

  let intervalMs = null;
  let expiresAt = null;
  let maxRuns = null;
  if (tokens[index] === 'every') {
    intervalMs = parsePeriod(tokens[index + 1]);
    if (intervalMs === null) {
      return rejected('cron 周期应为正整数加 m/h/d/w');
    }
    index += 2;

    if (tokens[index] === 'until') {
      expiresAt = parseShanghaiTimestamp(tokens[index + 1]);
      if (expiresAt === null || expiresAt <= firstRunAt) {
        return rejected('cron until 必须晚于首次时间');
      }
      index += 2;
    } else if (tokens[index] === 'never') {
      index += 1;
    } else if (tokens[index] === 'times') {
      maxRuns = parseRunCount(tokens[index + 1]);
      if (maxRuns === null) {
        return rejected('cron times 必须是正整数');
      }
      index += 2;
    }
  }

  let notifyCreator = true;
  if (tokens[index] === 'broadcast') {
    notifyCreator = false;
    index += 1;
  }

  if (index !== tokens.length) {
    return rejected('cron 语法无效');
  }

  if (intervalMs !== null && intervalMs < HOUR_MS) {
    const boundedRunCount = maxRuns ?? (expiresAt === null ? null : getRunCountUntil(firstRunAt, expiresAt, intervalMs));
    if (boundedRunCount === null || boundedRunCount > 10) {
      return rejected('cron 小于 1 小时的周期必须限制为不超过 10 次');
    }
  }

  return {
    kind: 'valid',
    schedule: {
      firstRunAt,
      intervalMs,
      expiresAt,
      maxRuns,
      notifyCreator,
      content,
    },
  };
}
