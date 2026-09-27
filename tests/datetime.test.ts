import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_TIME_ZONE, formatSydneyDateTime, isSydneyMorningWindow, sydneyCalendarDate } from '../lib/datetime';

test('all displayed times use Sydney winter and summer offsets', () => {
  assert.equal(APP_TIME_ZONE, 'Australia/Sydney');
  assert.equal(formatSydneyDateTime('2026-09-18T02:00:00Z'), '18/09/2026, 12:00 AEST');
  assert.equal(formatSydneyDateTime('2026-12-18T02:00:00Z'), '18/12/2026, 13:00 AEDT');
});

test('Sydney date rollover and daylight-saving transition are correct', () => {
  assert.equal(formatSydneyDateTime('2026-10-03T15:59:00Z'), '04/10/2026, 01:59 AEST');
  assert.equal(formatSydneyDateTime('2026-10-03T16:01:00Z'), '04/10/2026, 03:01 AEDT');
});

test('midnight renders as 00:xx and invalid input never throws', () => {
  assert.equal(formatSydneyDateTime('2026-09-17T14:00:00Z'), '18/09/2026, 00:00 AEST');
  assert.equal(formatSydneyDateTime('not a date'), 'Invalid date');
});

test('morning digest window follows Sydney winter and summer offsets', () => {
  assert.equal(sydneyCalendarDate(new Date('2026-09-17T21:00:00Z')), '2026-09-18');
  assert.equal(isSydneyMorningWindow(new Date('2026-09-17T20:59:00Z')), false);
  assert.equal(isSydneyMorningWindow(new Date('2026-09-17T21:00:00Z')), true);
  assert.equal(isSydneyMorningWindow(new Date('2026-12-17T19:59:00Z')), false);
  assert.equal(isSydneyMorningWindow(new Date('2026-12-17T20:00:00Z')), true);
});
