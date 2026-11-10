import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY, CHANNEL, EVENT_TYPE, LIFT_TYPE, OPEN_STATUSES, SEVERITY, TICKET_STATUS } from './catalog.js';
import { ticketLink } from './auth.js';
import { isValidTime } from './rules.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);

export function str(v, max = 500) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

export function pct(v) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('Charge must be between 0 and 100%');
  return n;
}

export function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad('Hour meter must be a positive number');
  return n;
}

const PHOTO_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': {
    ext: 'webp',
    magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  },
};
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

export function createService({ store, notifier, config }) {
  function findLift({ liftId, unit }) {
    const lift = liftId ? store.getLift(Number(liftId)) : unit ? store.getLiftByUnit(str(unit, 40)) : null;
    if (!lift || !lift.active) throw new HttpError(404, 'Lift not found — check the unit number');
    return lift;
  }

  function savePhoto(dataUrl) {
    if (!dataUrl) return null;
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(String(dataUrl));
    const kind = m && PHOTO_TYPES[m[1]];
    if (!kind) throw bad('Photo must be a JPEG, PNG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_PHOTO_BYTES) throw bad('Photo is too large (max 6 MB)');
    if (!kind.magic(buf)) throw bad('Photo file is not a valid image');
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const filename = `${crypto.randomUUID()}.${kind.ext}`;
    fs.writeFileSync(path.join(config.uploadsDir, filename), buf);
    return filename;
  }

  const ruleEvent = (type, lift, extra = {}) => ({ type, liftType: lift.type, lift, at: new Date(), ...extra });

  function reportIssue(input) {
    const clientId = str(input.clientId, 64);
    const existing = store.findTicketByClientId(clientId);
    if (existing) return { ticket: existing, notified: [], duplicate: true };

    const lift = findLift(input);
    const category = str(input.category, 40);
    const severity = str(input.severity, 20);
    const reportedBy = str(input.reportedBy, 80);
    if (!CATEGORY[category]) throw bad('Pick what kind of problem it is');
    if (!SEVERITY[severity]) throw bad('Pick whether the lift is down or still usable');
    if (reportedBy.length < 2) throw bad('Enter your name');

    const photoFilename = savePhoto(input.photo);
    const ticket = store.createTicket({
      clientId: clientId || null,
      liftId: lift.id,
      category,
      severity,
      description: str(input.description, 1000),
      errorCode: str(input.errorCode, 40),
      reportedBy,
      photoFilename,
    });
    const { recipients } = notifier.notify(
      ruleEvent('issue_reported', lift, {
        category,
        severity,
        ticket,
        link: ticketLink(config, ticket.id),
      }),
    );
    return { ticket, notified: recipients, duplicate: false };
  }

  function addNote(ticketId, input) {
    const ticket = store.getTicket(Number(ticketId));
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    const note = str(input.note, 1000);
    const actor = str(input.actor ?? input.reportedBy, 80);
    if (!note) throw bad('Write a note first');
    if (actor.length < 2) throw bad('Enter your name');
    return store.addTicketNote(ticket.id, { note, actor });
  }

  function updateStatus(ticketId, input) {
    const before = store.getTicket(Number(ticketId));
    if (!before) throw new HttpError(404, 'Ticket not found');
    const status = str(input.status, 20);
    if (!TICKET_STATUS[status]) throw bad('Unknown status');
    const actor = str(input.actor, 80);
    if (actor.length < 2) throw bad('Enter your name');
    const resolution = input.resolution === undefined ? undefined : str(input.resolution, 1000);
    if (status === 'resolved' && !(resolution ?? before.resolution)) {
      throw bad('Say what was fixed before resolving');
    }
    const ticket = store.updateTicketStatus(before.id, {
      status,
      note: str(input.note, 1000),
      actor,
      assignedTo: input.assignedTo === undefined ? undefined : str(input.assignedTo, 80),
      resolution,
    });

    let notified = [];
    if (status === 'resolved' && before.status !== 'resolved') {
      const lift = store.getLift(ticket.liftId);
      const otherOpenCount = store
        .listTickets({ status: 'open', liftId: lift.id })
        .filter((t) => t.id !== ticket.id).length;
      notified = notifier.notify(
        ruleEvent('issue_resolved', lift, {
          category: ticket.category,
          severity: ticket.severity,
          ticket,
          actor,
          otherOpenCount,
          link: ticketLink(config, ticket.id),
        }),
      ).recipients;
    }
    return { ticket, notified };
  }

  function logBattery(input) {
    const clientId = str(input.clientId, 64);
    const existing = store.findBatteryByClientId(clientId);
    if (existing) return { event: existing, notified: [], lowCharge: false, duplicate: true };

    const lift = findLift(input);
    const kind = str(input.kind, 10);
    if (kind !== 'change' && kind !== 'charge') throw bad('Pick battery change or charge level');
    const reportedBy = str(input.reportedBy, 80);
    if (reportedBy.length < 2) throw bad('Enter your name');
    const chargePct = pct(input.chargePct);
    if (kind === 'charge' && chargePct == null) throw bad('Pick the charge level');

    const event = store.createBatteryEvent({
      clientId: clientId || null,
      liftId: lift.id,
      kind,
      batteryIn: kind === 'change' ? str(input.batteryIn, 40) : '',
      batteryOut: kind === 'change' ? str(input.batteryOut, 40) : '',
      chargePct,
      outChargePct: kind === 'change' ? pct(input.outChargePct) : null,
      hourMeter: num(input.hourMeter),
      notes: str(input.notes, 500),
      reportedBy,
    });

    const settings = store.getSettings();
    const lowCharge = chargePct != null && chargePct <= settings.lowChargePct;
    const notified = [];
    const merge = (list) => {
      for (const r of list) if (!notified.some((n) => n.name === r.name)) notified.push(r);
    };
    if (kind === 'change') merge(notifier.notify(ruleEvent('battery_change', lift, { battery: event })).recipients);
    if (lowCharge) merge(notifier.notify(ruleEvent('low_battery', lift, { battery: event })).recipients);
    return { event, notified, lowCharge, duplicate: false };
  }

  // Re-alert (to escalation rules) on DOWN tickets nobody acknowledged in time.
  function runEscalation(now = Date.now()) {
    const { escalateAfterMinutes } = store.getSettings();
    if (!(escalateAfterMinutes > 0)) return [];
    const cutoff = new Date(now - escalateAfterMinutes * 60e3).toISOString();
    const escalated = [];
    for (const ticket of store.listUnacknowledgedDown(cutoff)) {
      store.markEscalated(ticket.id);
      const lift = store.getLift(ticket.liftId);
      const { recipients } = notifier.notify(
        ruleEvent('issue_escalated', lift, {
          category: ticket.category,
          severity: ticket.severity,
          ticket,
          link: ticketLink(config, ticket.id),
        }),
      );
      store.addTicketNote(ticket.id, {
        kind: 'escalated',
        actor: 'System',
        note: `Not acknowledged within ${escalateAfterMinutes} min — escalated to ${
          recipients.map((r) => r.name).join(', ') || 'nobody — check the escalation rule and people’s contact info'
        }`,
      });
      escalated.push(ticket.id);
    }
    return escalated;
  }

  // What did the worker just scan? Works for NFC tags (serial number and/or
  // NDEF text/URL written on the tag) and barcodes typed in by the Zebra
  // DataWedge keyboard wedge. Order: data written on the tag, then the tag
  // registry, then a bare lift unit number.
  function resolveScan(input) {
    const serial = normalizeUid(str(input.serial, 100));
    const text = str(input.text, 500);
    let hit = text ? parseTagText(text) : null;
    if (!hit && serial) hit = tagHit(store.getTagByUid(serial));
    if (!hit && text) {
      const lift = store.getLiftByUnit(text);
      hit = lift?.active ? { kind: 'lift', ref: lift.unit } : tagHit(store.getTagByUid(normalizeUid(text)));
    }
    if (!hit) return { kind: 'unknown', serial, text };

    if (hit.kind === 'lift') {
      const lift = store.getLiftByUnit(hit.ref);
      if (!lift?.active) {
        return { kind: 'unknown', serial, text, message: `This tag is for ${hit.ref}, which is not in the fleet` };
      }
      return { kind: 'lift', ref: lift.unit, lift: { unit: lift.unit, type: lift.type, status: lift.status, power: lift.power } };
    }
    if (hit.kind === 'battery') {
      const where = store.batteryInventory().find((b) => b.battery.toUpperCase() === hit.ref.toUpperCase());
      return { kind: 'battery', ref: hit.ref, location: where ?? null };
    }
    return { kind: 'person', ref: hit.ref };
  }

  return { findLift, reportIssue, addNote, updateStatus, logBattery, runEscalation, resolveScan };
}

const TAG_KINDS = ['lift', 'battery', 'person'];
const tagHit = (tag) => (tag ? { kind: tag.kind, ref: tag.ref } : null);

// NFC serials arrive as "04:a2:3b…" (Web NFC) or "04-A2-3B…"; store one form.
export function normalizeUid(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (/^[0-9A-F]{2}([:\- ][0-9A-F]{2})+$/.test(v)) return v.replace(/[\- ]/g, ':');
  return v;
}

// Data written on a tag or encoded in a barcode:
//   "lift:R-03"  "battery:B-12"  "person:Maria Lopez"
//   https://<site>/l/R-03   https://<site>/b/B-12   https://<site>/?lift=R-03
export function parseTagText(text) {
  const t = String(text).trim();
  const prefixed = /^(lift|battery|person)\s*[:=]\s*(.+)$/i.exec(t);
  if (prefixed) return { kind: prefixed[1].toLowerCase(), ref: prefixed[2].trim() };
  if (/^https?:\/\//i.test(t)) {
    try {
      const url = new URL(t);
      const m = /^\/(l|b)\/([^/]+)\/?$/.exec(url.pathname);
      if (m) return { kind: m[1] === 'l' ? 'lift' : 'battery', ref: decodeURIComponent(m[2]) };
      const lift = url.searchParams.get('lift');
      if (lift) return { kind: 'lift', ref: lift };
      const scan = url.searchParams.get('scan');
      if (scan) return parseTagText(scan);
    } catch {
      /* not a URL after all */
    }
  }
  return null;
}

export function cleanTag(input, { store }) {
  const uid = normalizeUid(str(input.uid, 100));
  if (!uid) throw bad('Scan or type the tag ID');
  const kind = str(input.kind, 20);
  if (!TAG_KINDS.includes(kind)) throw bad('Pick what the tag is for');
  let ref = str(input.ref, 80);
  if (!ref) throw bad(kind === 'lift' ? 'Pick the lift' : kind === 'battery' ? 'Enter the battery number' : 'Enter the name');
  if (kind === 'lift') {
    const lift = store.getLiftByUnit(ref);
    if (!lift) throw bad(`No lift "${ref}"`);
    ref = lift.unit;
  }
  return { uid, kind, ref };
}

// ---------- validation for manager setup forms ----------

export function cleanLift(input) {
  const unit = str(input.unit, 40);
  if (!unit) throw bad('Unit number is required');
  if (!LIFT_TYPE[input.type]) throw bad('Pick a lift type');
  const power = input.power === 'lithium' ? 'lithium' : 'lead_acid';
  return {
    unit,
    type: input.type,
    model: str(input.model, 80),
    serial: str(input.serial, 80),
    zone: str(input.zone, 80),
    power,
    active: input.active !== false,
  };
}

export function cleanContact(input) {
  const name = str(input.name, 80);
  if (!name) throw bad('Name is required');
  const email = str(input.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Email address looks wrong');
  const phone = str(input.phone, 30).replace(/[\s().-]/g, '');
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw bad('Phone must be in international format, e.g. +15551234567');
  }
  const webhookUrl = str(input.webhookUrl, 1000);
  if (webhookUrl && !/^https:\/\//i.test(webhookUrl)) throw bad('Webhook URL must start with https://');
  return { name, role: str(input.role, 80), email, phone, webhookUrl, active: input.active !== false };
}

export function cleanRule(input, { contacts }) {
  const name = str(input.name, 120);
  if (!name) throw bad('Give the rule a name');
  const pick = (list, allowed, label) => {
    if (list == null) return [];
    if (!Array.isArray(list)) throw bad(`${label} must be a list`);
    const out = [...new Set(list)];
    for (const v of out) if (!allowed(v)) throw bad(`Unknown ${label}: ${v}`);
    return out;
  };
  const contactIds = new Set(contacts.map((c) => c.id));
  const rule = {
    name,
    enabled: input.enabled !== false,
    eventTypes: pick(input.eventTypes, (v) => EVENT_TYPE[v], 'event type'),
    liftTypes: pick(input.liftTypes, (v) => LIFT_TYPE[v], 'lift type'),
    categories: pick(input.categories, (v) => CATEGORY[v], 'category'),
    severities: pick(input.severities, (v) => SEVERITY[v], 'severity'),
    days: pick(input.days, (v) => Number.isInteger(v) && v >= 0 && v <= 6, 'day'),
    timeStart: str(input.timeStart, 5),
    timeEnd: str(input.timeEnd, 5),
    contactIds: pick(input.contactIds, (v) => contactIds.has(v), 'contact'),
    channels: pick(input.channels, (v) => CHANNEL[v], 'channel'),
  };
  if (!isValidTime(rule.timeStart) || !isValidTime(rule.timeEnd)) throw bad('Times must look like 06:00');
  if (!rule.timeStart !== !rule.timeEnd) throw bad('Set both a start and end time, or neither');
  if (!rule.contactIds.length) throw bad('Pick at least one person to alert');
  if (!rule.channels.length) throw bad('Pick at least one way to alert them');
  return rule;
}

export { OPEN_STATUSES };
