// Domain catalog: lift types, issue categories, severities, ticket statuses and
// alert event types. Everything the UI and rules engine needs to agree on lives
// here so there is exactly one list of valid keys.
//
// To add a new lift type (e.g. "order_picker"), add an entry to LIFT_TYPES —
// it will automatically show up in the worker app, the manager dashboard and
// the alert-rule editor.

export const LIFT_TYPES = [
  { key: 'raymond_reach', label: 'Raymond High Reach Truck', short: 'Raymond Reach', make: 'Raymond' },
  { key: 'linde_reach', label: 'Linde Reach Truck', short: 'Linde Reach', make: 'Linde' },
  { key: 'dock', label: 'Dock Truck', short: 'Dock Truck', make: '' },
];

// `safety` = safety-critical. The worker app pushes these toward "DOWN" and
// shows a tag-out reminder, because OSHA 1910.178(q)(1) requires trucks that
// are unsafe to be taken out of service until repaired.
export const ISSUE_CATEGORIES = [
  { key: 'wont_start', label: "Won't start / no power", icon: '⛔', safety: false },
  { key: 'hydraulics', label: 'Lift / lower / hydraulics', icon: '↕️', safety: false },
  { key: 'mast_forks', label: 'Mast, forks, chains, reach', icon: '🍴', safety: true },
  { key: 'brakes', label: 'Brakes', icon: '🛑', safety: true },
  { key: 'steering', label: 'Steering', icon: '🎯', safety: true },
  { key: 'drive', label: 'Drive / travel / traction', icon: '⚙️', safety: false },
  { key: 'leak', label: 'Fluid or acid leak', icon: '💧', safety: true },
  { key: 'battery', label: 'Battery / charging / connector', icon: '🔋', safety: false },
  { key: 'error_code', label: 'Error code / display', icon: '⚠️', safety: false },
  { key: 'safety_devices', label: 'Horn, lights, alarm, deadman', icon: '📢', safety: true },
  { key: 'wheels', label: 'Wheels / tires / casters', icon: '🛞', safety: false },
  { key: 'damage', label: 'Collision / physical damage', icon: '💥', safety: false },
  { key: 'other', label: 'Something else', icon: '❓', safety: false },
];

export const SEVERITIES = [
  { key: 'down', label: 'DOWN — not safe / can’t use', short: 'Down' },
  { key: 'repair', label: 'Still runs — needs repair', short: 'Needs repair' },
];

export const TICKET_STATUSES = [
  { key: 'open', label: 'Open', closed: false },
  { key: 'acknowledged', label: 'Acknowledged', closed: false },
  { key: 'in_progress', label: 'Tech working on it', closed: false },
  { key: 'waiting_parts', label: 'Waiting on parts', closed: false },
  { key: 'resolved', label: 'Resolved', closed: true },
];

export const EVENT_TYPES = [
  { key: 'issue_reported', label: 'Problem reported', short: 'a problem is reported' },
  { key: 'issue_escalated', label: 'DOWN lift not acknowledged in time (escalation)', short: 'a DOWN lift is not acknowledged in time' },
  { key: 'issue_resolved', label: 'Problem resolved / lift back in service', short: 'a problem is fixed' },
  { key: 'battery_change', label: 'Battery changed', short: 'a battery is changed' },
  { key: 'low_battery', label: 'Low charge reported', short: 'low charge is reported' },
];

export const CHANNELS = [
  { key: 'sms', label: 'Text (SMS)', short: 'text' },
  { key: 'email', label: 'Email', short: 'email' },
  { key: 'webhook', label: 'Teams / Slack webhook', short: 'Teams/Slack' },
];

export const POWER_TYPES = [
  { key: 'lead_acid', label: 'Lead-acid (swappable)' },
  { key: 'lithium', label: 'Lithium-ion (opportunity charge)' },
];

const index = (list) => Object.fromEntries(list.map((item) => [item.key, item]));

export const LIFT_TYPE = index(LIFT_TYPES);
export const CATEGORY = index(ISSUE_CATEGORIES);
export const SEVERITY = index(SEVERITIES);
export const TICKET_STATUS = index(TICKET_STATUSES);
export const EVENT_TYPE = index(EVENT_TYPES);
export const CHANNEL = index(CHANNELS);
export const POWER_TYPE = index(POWER_TYPES);

export const OPEN_STATUSES = TICKET_STATUSES.filter((s) => !s.closed).map((s) => s.key);

export function liftTypeLabel(key) {
  return LIFT_TYPE[key]?.label ?? key;
}

export function categoryLabel(key) {
  return CATEGORY[key]?.label ?? key;
}

export function catalog() {
  return {
    liftTypes: LIFT_TYPES,
    categories: ISSUE_CATEGORIES,
    severities: SEVERITIES,
    ticketStatuses: TICKET_STATUSES,
    eventTypes: EVENT_TYPES,
    channels: CHANNELS,
    powerTypes: POWER_TYPES,
  };
}
