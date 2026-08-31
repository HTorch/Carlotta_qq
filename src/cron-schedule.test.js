import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBeijingMinute, getFirstFutureRun, parseCronSchedule } from './cron-schedule.js';

const NOW = new Date('2026-08-15T10:50:45.000Z');

test('CronSchedule parses an explicit finite broadcast schedule', () => {
  const result = parseCronSchedule('202608151851 every 1m times 10 broadcast | 记得吃饭', { now: NOW });

  assert.equal(result.kind, 'valid');
  assert.equal(result.schedule.firstRunAt, Date.parse('2026-08-15T10:51:00.000Z'));
  assert.equal(result.schedule.intervalMs, 60_000);
  assert.equal(result.schedule.maxRuns, 10);
  assert.equal(result.schedule.expiresAt, null);
  assert.equal(result.schedule.notifyCreator, false);
  assert.equal(result.schedule.content, ' 记得吃饭');
});

test('CronSchedule uses the received Beijing minute when start time is omitted', () => {
  const result = parseCronSchedule('every 1d broadcast | 会议开始', { now: NOW });

  assert.equal(result.kind, 'valid');
  assert.equal(formatBeijingMinute(result.schedule.firstRunAt), '2026-08-15 18:50');
  assert.equal(result.schedule.intervalMs, 86_400_000);
  assert.equal(result.schedule.notifyCreator, false);
});

test('CronSchedule rejects invalid short-period termination rules', () => {
  for (const commandText of [
    '202608151851 every 1m | 喝水',
    '202608151851 every 1m never | 喝水',
    '202608151851 every 1m times 11 | 喝水',
    '202608151851 every 1m until 202608151901 | 喝水',
  ]) {
    const result = parseCronSchedule(commandText, { now: NOW });
    assert.equal(result.kind, 'rejected');
  }
});

test('CronSchedule rejects malformed and past explicit timestamps', () => {
  for (const commandText of [
    '202602300900 | 无效日期',
    '202608151049 | 已过去',
    '202608151051 every 0m | 无效周期',
    '202608151051 until 202608151052 | 缺少 every',
    '202608151051 broadcast broadcast | 重复标记',
    '202608151051 |   ',
  ]) {
    const result = parseCronSchedule(commandText, { now: NOW });
    assert.equal(result.kind, 'rejected');
  }
});

test('CronSchedule preserves everything after the first body delimiter', () => {
  const result = parseCronSchedule('202608151851 | first | second', { now: NOW });

  assert.equal(result.kind, 'valid');
  assert.equal(result.schedule.content, ' first | second');
});

test('CronSchedule advances repeating reminders to the first future run', () => {
  const firstRunAt = Date.parse('2026-08-15T10:00:00.000Z');
  const result = getFirstFutureRun({
    firstRunAt,
    intervalMs: 60_000,
    now: Date.parse('2026-08-15T10:05:15.000Z'),
  });

  assert.equal(result, Date.parse('2026-08-15T10:06:00.000Z'));
});
