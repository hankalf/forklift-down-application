// Alert rules engine (pure functions, no I/O).
//
// A rule matches an event when every filter on the rule is satisfied. An empty
// filter list means "any". Example: { liftTypes: ['linde_reach'],
// severities: ['down'] } matches every DOWN report on a Linde reach truck,
// whatever the category.
//
// An event looks like:
//   { type: 'issue_reported', liftType: 'raymond_reach', category: 'brakes',
//     severity: 'down', at: Date }
// Battery events have no category/severity, so rules filtered by category or
// severity never match them.

const CHANNEL_ORDER = ['sms', 'email', 'webhook'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value) {
  return value === '' || TIME_RE.test(value);
}

function minutesOfDay(hhmm) {
  const m = TIME_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function listAllows(list, value) {
  if (!list || list.length === 0) return true;
  return value != null && list.includes(value);
}

// Shift window check. Windows can wrap midnight (e.g. 22:00 → 06:00). For a
// wrapping window, the part after midnight belongs to the previous day's
// shift, so `days` is checked against the day the shift started.
export function inSchedule(rule, at = new Date()) {
  const days = rule.days ?? [];
  const start = minutesOfDay(rule.timeStart ?? '');
  const end = minutesOfDay(rule.timeEnd ?? '');
  const minute = at.getHours() * 60 + at.getMinutes();
  let shiftDay = at.getDay();

  if (start != null && end != null && start !== end) {
    if (start < end) {
      if (minute < start || minute >= end) return false;
    } else {
      const inLate = minute >= start;
      const inEarly = minute < end;
      if (!inLate && !inEarly) return false;
      if (inEarly) shiftDay = (shiftDay + 6) % 7;
    }
  }
  return days.length === 0 || days.includes(shiftDay);
}

export function ruleMatches(rule, event) {
  if (!rule.enabled) return false;
  return (
    listAllows(rule.eventTypes, event.type) &&
    listAllows(rule.liftTypes, event.liftType) &&
    listAllows(rule.categories, event.category) &&
    listAllows(rule.severities, event.severity) &&
    inSchedule(rule, event.at ?? new Date())
  );
}

// Merge every matching rule into one entry per contact with the union of
// channels, so nobody gets the same alert twice when several rules match.
export function resolveRecipients(rules, contacts, event) {
  const contactById = new Map(contacts.filter((c) => c.active).map((c) => [c.id, c]));
  const byContact = new Map();
  for (const rule of rules) {
    if (!ruleMatches(rule, event)) continue;
    for (const contactId of rule.contactIds) {
      const contact = contactById.get(contactId);
      if (!contact) continue;
      if (!byContact.has(contactId)) {
        byContact.set(contactId, { contact, channels: new Set(), rules: [] });
      }
      const entry = byContact.get(contactId);
      for (const ch of rule.channels) entry.channels.add(ch);
      entry.rules.push({ id: rule.id, name: rule.name });
    }
  }
  return [...byContact.values()].map((e) => ({
    contact: e.contact,
    channels: CHANNEL_ORDER.filter((ch) => e.channels.has(ch)),
    rules: e.rules,
  }));
}

// Address for a contact on a channel, or '' if they don't have one.
export function destinationFor(contact, channel) {
  if (channel === 'email') return contact.email ?? '';
  if (channel === 'sms') return contact.phone ?? '';
  if (channel === 'webhook') return contact.webhookUrl ?? '';
  return '';
}
