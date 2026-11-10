import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inSchedule, resolveRecipients, ruleMatches } from '../src/rules.js';

const rule = (over = {}) => ({
  id: 1,
  name: 'r',
  enabled: true,
  eventTypes: [],
  liftTypes: [],
  categories: [],
  severities: [],
  days: [],
  timeStart: '',
  timeEnd: '',
  contactIds: [1],
  channels: ['sms'],
  ...over,
});

// Local-time date helper: 2026-11-09 is a Monday.
const at = (day, hh, mm = 0) => new Date(2026, 10, 8 + day, hh, mm);

const brakesDown = { type: 'issue_reported', liftType: 'raymond_reach', category: 'brakes', severity: 'down', at: at(1, 10) };

describe('ruleMatches', () => {
  it('treats empty filters as "any"', () => {
    assert.equal(ruleMatches(rule(), brakesDown), true);
  });

  it('filters on lift type, category, severity and event type', () => {
    assert.equal(ruleMatches(rule({ liftTypes: ['raymond_reach'] }), brakesDown), true);
    assert.equal(ruleMatches(rule({ liftTypes: ['linde_reach', 'dock'] }), brakesDown), false);
    assert.equal(ruleMatches(rule({ categories: ['brakes', 'steering'] }), brakesDown), true);
    assert.equal(ruleMatches(rule({ categories: ['hydraulics'] }), brakesDown), false);
    assert.equal(ruleMatches(rule({ severities: ['repair'] }), brakesDown), false);
    assert.equal(ruleMatches(rule({ eventTypes: ['issue_resolved'] }), brakesDown), false);
  });

  it('never matches category/severity rules for battery events', () => {
    const lowBattery = { type: 'low_battery', liftType: 'linde_reach', at: at(1, 10) };
    assert.equal(ruleMatches(rule({ categories: ['battery'] }), lowBattery), false);
    assert.equal(ruleMatches(rule({ eventTypes: ['low_battery'] }), lowBattery), true);
  });

  it('ignores disabled rules', () => {
    assert.equal(ruleMatches(rule({ enabled: false }), brakesDown), false);
  });
});

describe('inSchedule (shift windows)', () => {
  const firstShift = rule({ timeStart: '06:00', timeEnd: '14:30', days: [1, 2, 3, 4, 5] });

  it('matches inside a same-day window on listed days', () => {
    assert.equal(inSchedule(firstShift, at(1, 6, 0)), true);
    assert.equal(inSchedule(firstShift, at(1, 14, 29)), true);
    assert.equal(inSchedule(firstShift, at(1, 14, 30)), false);
    assert.equal(inSchedule(firstShift, at(1, 5, 59)), false);
    assert.equal(inSchedule(firstShift, at(6, 10)), false); // Saturday
  });

  it('handles overnight windows and credits the early hours to the shift start day', () => {
    const nights = rule({ timeStart: '22:00', timeEnd: '06:00', days: [1, 2, 3, 4, 5] }); // Mon–Fri nights
    assert.equal(inSchedule(nights, at(1, 23)), true); // Mon 23:00
    assert.equal(inSchedule(nights, at(2, 3)), true); // Tue 03:00 → Monday's shift
    assert.equal(inSchedule(nights, at(6, 3)), true); // Sat 03:00 → Friday's shift
    assert.equal(inSchedule(nights, at(1, 3)), false); // Mon 03:00 → Sunday's shift
    assert.equal(inSchedule(nights, at(3, 12)), false); // midday
  });

  it('matches all day when no times are set', () => {
    assert.equal(inSchedule(rule({ days: [0] }), at(7, 12)), true); // Sunday
    assert.equal(inSchedule(rule(), at(3, 2)), true);
  });
});

describe('resolveRecipients', () => {
  const contacts = [
    { id: 1, name: 'Manager', active: true },
    { id: 2, name: 'Raymond Tech', active: true },
    { id: 3, name: 'Former employee', active: false },
  ];

  it('merges channels per contact across rules and skips inactive contacts', () => {
    const rules = [
      rule({ id: 1, name: 'down', severities: ['down'], contactIds: [1, 3], channels: ['sms'] }),
      rule({ id: 2, name: 'raymond', liftTypes: ['raymond_reach'], contactIds: [1, 2], channels: ['email'] }),
      rule({ id: 3, name: 'linde', liftTypes: ['linde_reach'], contactIds: [2], channels: ['sms'] }),
    ];
    const out = resolveRecipients(rules, contacts, brakesDown);
    const byName = Object.fromEntries(out.map((r) => [r.contact.name, r]));
    assert.deepEqual(Object.keys(byName).sort(), ['Manager', 'Raymond Tech']);
    assert.deepEqual(byName.Manager.channels.sort(), ['email', 'sms']);
    assert.deepEqual(byName['Raymond Tech'].channels, ['email']);
    assert.deepEqual(byName.Manager.rules.map((r) => r.id), [1, 2]);
  });
});
