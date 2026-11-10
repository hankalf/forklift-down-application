import { transaction } from './db.js';

// Starter contacts have no email/phone yet — the manager fills those in under
// Setup → People. Until then alerts to them show as "skipped" in the alert log.
const STARTER_CONTACTS = [
  { key: 'wm', name: 'Warehouse Manager', role: 'Warehouse Manager' },
  { key: 'maint', name: 'Maintenance Lead', role: 'In-house maintenance' },
  { key: 'raymond', name: 'Raymond Dealer Service', role: 'Raymond service tech' },
  { key: 'linde', name: 'Linde Dealer Service', role: 'Linde service tech' },
  { key: 'dock', name: 'Dock Supervisor', role: 'Shipping / receiving' },
  { key: 'safety', name: 'Safety Coordinator', role: 'EHS / Safety' },
  { key: 'battery', name: 'Battery Room', role: 'Battery changes & charging' },
  { key: 'ops', name: 'Operations Manager', role: 'Escalation' },
  { key: 'channel', name: 'Shift Team Channel', role: 'Teams / Slack channel' },
];

const STARTER_RULES = [
  {
    name: 'Any lift DOWN → Warehouse Manager + Maintenance',
    eventTypes: ['issue_reported'],
    severities: ['down'],
    contacts: ['wm', 'maint'],
    channels: ['sms', 'email'],
  },
  {
    name: 'Needs repair (still running) → Maintenance',
    eventTypes: ['issue_reported'],
    severities: ['repair'],
    contacts: ['maint'],
    channels: ['email'],
  },
  {
    name: 'Raymond High Reach problems → Raymond dealer',
    eventTypes: ['issue_reported', 'issue_escalated'],
    liftTypes: ['raymond_reach'],
    contacts: ['raymond'],
    channels: ['email', 'sms'],
  },
  {
    name: 'Linde Reach problems → Linde dealer',
    eventTypes: ['issue_reported', 'issue_escalated'],
    liftTypes: ['linde_reach'],
    contacts: ['linde'],
    channels: ['email', 'sms'],
  },
  {
    name: 'Dock truck problems → Dock Supervisor',
    eventTypes: ['issue_reported', 'issue_resolved'],
    liftTypes: ['dock'],
    contacts: ['dock'],
    channels: ['sms'],
  },
  {
    name: 'Safety-critical problems → Safety Coordinator',
    eventTypes: ['issue_reported'],
    categories: ['brakes', 'steering', 'mast_forks', 'leak', 'safety_devices'],
    contacts: ['safety'],
    channels: ['sms', 'email'],
  },
  {
    name: 'Battery / charging problems → Battery Room',
    eventTypes: ['issue_reported'],
    categories: ['battery', 'wont_start'],
    contacts: ['battery'],
    channels: ['sms'],
  },
  {
    name: 'Low charge reported → Battery Room',
    eventTypes: ['low_battery'],
    contacts: ['battery'],
    channels: ['sms'],
  },
  {
    name: 'DOWN and not acknowledged in time → Operations Manager',
    eventTypes: ['issue_escalated'],
    contacts: ['ops', 'wm'],
    channels: ['sms', 'email'],
  },
  {
    name: 'Lift back in service → Warehouse Manager',
    eventTypes: ['issue_resolved'],
    contacts: ['wm'],
    channels: ['email'],
  },
  {
    name: 'Post every problem & fix to the team channel',
    eventTypes: ['issue_reported', 'issue_escalated', 'issue_resolved'],
    contacts: ['channel'],
    channels: ['webhook'],
  },
];

const DEMO_LIFTS = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ unit: `R-${String(n).padStart(2, '0')}`, type: 'raymond_reach', zone: 'Aisles 1–12' })),
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ unit: `L-${String(n).padStart(2, '0')}`, type: 'linde_reach', zone: 'Aisles 13–24' })),
  ...[1, 2, 3, 4].map((n) => ({ unit: `D-${String(n).padStart(2, '0')}`, type: 'dock', zone: 'Dock' })),
];

export function seedIfEmpty(store, { demoLifts = true } = {}) {
  const db = store.db;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  if (count('contacts') || count('alert_rules') || count('lifts')) return false;

  transaction(db, () => {
    const ids = {};
    for (const c of STARTER_CONTACTS) {
      ids[c.key] = store.createContact({ name: c.name, role: c.role }).id;
    }
    for (const r of STARTER_RULES) {
      store.createRule({
        name: r.name,
        enabled: true,
        eventTypes: r.eventTypes ?? [],
        liftTypes: r.liftTypes ?? [],
        categories: r.categories ?? [],
        severities: r.severities ?? [],
        contactIds: r.contacts.map((k) => ids[k]),
        channels: r.channels,
      });
    }
    if (demoLifts) for (const lift of DEMO_LIFTS) store.createLift(lift);
  });
  return true;
}
