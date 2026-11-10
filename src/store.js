import { transaction } from './db.js';
import { CATEGORY, LIFT_TYPE, LIFT_TYPES, OPEN_STATUSES, SEVERITY, TICKET_STATUS } from './catalog.js';

export const DEFAULT_SETTINGS = {
  siteName: 'Warehouse',
  lowChargePct: 20,
  escalateAfterMinutes: 15,
};

const nowIso = () => new Date().toISOString();
const parseList = (text) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const openStatusSql = OPEN_STATUSES.map((s) => `'${s}'`).join(',');
// Sort lifts in catalog order (Raymond, Linde, Dock), then by unit number.
const liftOrderSql = `CASE l.type ${LIFT_TYPES.map((t, i) => `WHEN '${t.key}' THEN ${i}`).join(' ')} ELSE 99 END, l.unit`;

function mapLift(r) {
  if (!r) return null;
  const downCount = Number(r.down_count ?? 0);
  const openCount = Number(r.open_count ?? 0);
  return {
    id: r.id,
    unit: r.unit,
    type: r.type,
    typeLabel: LIFT_TYPE[r.type]?.label ?? r.type,
    model: r.model,
    serial: r.serial,
    zone: r.zone,
    power: r.power,
    active: !!r.active,
    createdAt: r.created_at,
    status: downCount > 0 ? 'down' : openCount > 0 ? 'repair' : 'available',
    openCount,
    downCount,
    downSince: r.down_since ?? null,
    lastCharge: r.last_charge_pct == null ? null : { pct: r.last_charge_pct, at: r.last_charge_at },
  };
}

function mapTicket(r) {
  if (!r) return null;
  return {
    id: r.id,
    clientId: r.client_id,
    liftId: r.lift_id,
    unit: r.unit,
    liftType: r.lift_type,
    liftTypeLabel: LIFT_TYPE[r.lift_type]?.label ?? r.lift_type,
    zone: r.zone ?? '',
    category: r.category,
    categoryLabel: CATEGORY[r.category]?.label ?? r.category,
    severity: r.severity,
    severityLabel: SEVERITY[r.severity]?.short ?? r.severity,
    description: r.description,
    errorCode: r.error_code,
    reportedBy: r.reported_by,
    status: r.status,
    statusLabel: TICKET_STATUS[r.status]?.label ?? r.status,
    assignedTo: r.assigned_to,
    resolution: r.resolution,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at,
    escalatedAt: r.escalated_at,
  };
}

function mapBattery(r) {
  if (!r) return null;
  return {
    id: r.id,
    clientId: r.client_id,
    liftId: r.lift_id,
    unit: r.unit,
    liftType: r.lift_type,
    kind: r.kind,
    batteryIn: r.battery_in,
    batteryOut: r.battery_out,
    chargePct: r.charge_pct,
    outChargePct: r.out_charge_pct,
    hourMeter: r.hour_meter,
    notes: r.notes,
    reportedBy: r.reported_by,
    createdAt: r.created_at,
  };
}

function mapContact(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    webhookUrl: r.webhook_url,
    active: !!r.active,
  };
}

function mapRule(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    eventTypes: parseList(r.event_types),
    liftTypes: parseList(r.lift_types),
    categories: parseList(r.categories),
    severities: parseList(r.severities),
    days: parseList(r.days),
    timeStart: r.time_start,
    timeEnd: r.time_end,
    contactIds: parseList(r.contact_ids),
    channels: parseList(r.channels),
  };
}

function mapNotification(r) {
  return {
    id: r.id,
    eventType: r.event_type,
    refType: r.ref_type,
    refId: r.ref_id,
    contactId: r.contact_id,
    contactName: r.contact_name,
    channel: r.channel,
    destination: r.destination,
    subject: r.subject,
    body: r.body,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
  };
}

const LIFT_SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM tickets t WHERE t.lift_id = l.id AND t.status IN (${openStatusSql})) AS open_count,
    (SELECT COUNT(*) FROM tickets t WHERE t.lift_id = l.id AND t.status IN (${openStatusSql}) AND t.severity = 'down') AS down_count,
    (SELECT MIN(t.created_at) FROM tickets t WHERE t.lift_id = l.id AND t.status IN (${openStatusSql}) AND t.severity = 'down') AS down_since,
    (SELECT b.charge_pct FROM battery_events b WHERE b.lift_id = l.id AND b.charge_pct IS NOT NULL ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS last_charge_pct,
    (SELECT b.created_at FROM battery_events b WHERE b.lift_id = l.id AND b.charge_pct IS NOT NULL ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS last_charge_at
  FROM lifts l`;

const TICKET_SELECT = `
  SELECT t.*, l.unit AS unit, l.type AS lift_type, l.zone AS zone
  FROM tickets t JOIN lifts l ON l.id = t.lift_id`;

const BATTERY_SELECT = `
  SELECT b.*, l.unit AS unit, l.type AS lift_type
  FROM battery_events b JOIN lifts l ON l.id = b.lift_id`;

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- settings ----------
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = { ...DEFAULT_SETTINGS };
    for (const { key, value } of rows) {
      if (key in DEFAULT_SETTINGS) {
        out[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : value;
      }
    }
    return out;
  }

  updateSettings(patch) {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS && value !== undefined) stmt.run(key, String(value));
    }
    return this.getSettings();
  }

  // ---------- lifts ----------
  listLifts({ includeInactive = false } = {}) {
    const where = includeInactive ? '' : 'WHERE l.active = 1';
    return this.db
      .prepare(`${LIFT_SELECT} ${where} ORDER BY ${liftOrderSql}`)
      .all()
      .map(mapLift);
  }

  getLift(id) {
    return mapLift(this.db.prepare(`${LIFT_SELECT} WHERE l.id = ?`).get(id));
  }

  getLiftByUnit(unit) {
    return mapLift(this.db.prepare(`${LIFT_SELECT} WHERE l.unit = ? COLLATE NOCASE`).get(unit));
  }

  createLift({ unit, type, model = '', serial = '', zone = '', power = 'lead_acid', active = true }) {
    const res = this.db
      .prepare(
        `INSERT INTO lifts (unit, type, model, serial, zone, power, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(unit, type, model, serial, zone, power, active ? 1 : 0, nowIso());
    return this.getLift(Number(res.lastInsertRowid));
  }

  updateLift(id, { unit, type, model, serial, zone, power, active }) {
    this.db
      .prepare(
        `UPDATE lifts SET unit = ?, type = ?, model = ?, serial = ?, zone = ?, power = ?, active = ?
         WHERE id = ?`,
      )
      .run(unit, type, model, serial, zone, power, active ? 1 : 0, id);
    return this.getLift(id);
  }

  // Lifts with history are retired (hidden) instead of deleted so reports stay intact.
  removeLift(id) {
    const used =
      this.db.prepare('SELECT 1 FROM tickets WHERE lift_id = ? LIMIT 1').get(id) ||
      this.db.prepare('SELECT 1 FROM battery_events WHERE lift_id = ? LIMIT 1').get(id);
    if (used) {
      this.db.prepare('UPDATE lifts SET active = 0 WHERE id = ?').run(id);
      return { retired: true };
    }
    this.db.prepare('DELETE FROM lifts WHERE id = ?').run(id);
    return { deleted: true };
  }

  // ---------- tickets ----------
  findTicketByClientId(clientId) {
    if (!clientId) return null;
    return mapTicket(this.db.prepare(`${TICKET_SELECT} WHERE t.client_id = ?`).get(clientId));
  }

  createTicket({ clientId, liftId, category, severity, description, errorCode, reportedBy, photoFilename }) {
    return transaction(this.db, () => {
      const ts = nowIso();
      const res = this.db
        .prepare(
          `INSERT INTO tickets (client_id, lift_id, category, severity, description, error_code,
             reported_by, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(clientId || null, liftId, category, severity, description, errorCode, reportedBy, ts, ts);
      const id = Number(res.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO ticket_events (ticket_id, kind, status, note, actor, created_at)
           VALUES (?, 'reported', 'open', ?, ?, ?)`,
        )
        .run(id, description, reportedBy, ts);
      if (photoFilename) this.addTicketPhoto(id, photoFilename);
      return this.getTicket(id);
    });
  }

  addTicketPhoto(ticketId, filename) {
    this.db
      .prepare('INSERT INTO ticket_photos (ticket_id, filename, created_at) VALUES (?, ?, ?)')
      .run(ticketId, filename, nowIso());
  }

  getTicket(id) {
    return mapTicket(this.db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id));
  }

  getTicketDetail(id) {
    const ticket = this.getTicket(id);
    if (!ticket) return null;
    ticket.events = this.db
      .prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, id')
      .all(id)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        statusLabel: e.status ? (TICKET_STATUS[e.status]?.label ?? e.status) : null,
        note: e.note,
        actor: e.actor,
        createdAt: e.created_at,
      }));
    ticket.photos = this.db
      .prepare('SELECT filename FROM ticket_photos WHERE ticket_id = ? ORDER BY id')
      .all(id)
      .map((p) => `/uploads/${p.filename}`);
    return ticket;
  }

  listTickets({ status = 'open', liftId, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (status === 'open') where.push(`t.status IN (${openStatusSql})`);
    else if (status === 'resolved') where.push(`t.status = 'resolved'`);
    if (liftId) {
      where.push('t.lift_id = ?');
      params.push(liftId);
    }
    const order =
      status === 'open'
        ? `CASE t.severity WHEN 'down' THEN 0 ELSE 1 END, t.created_at`
        : 't.created_at DESC';
    const sql = `${TICKET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${order} LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...params, limit)
      .map(mapTicket);
  }

  updateTicketStatus(id, { status, note = '', actor = '', assignedTo, resolution }) {
    return transaction(this.db, () => {
      const current = this.getTicket(id);
      if (!current) return null;
      const ts = nowIso();
      const sets = ['status = ?', 'updated_at = ?'];
      const params = [status, ts];
      if (status !== 'open' && !current.acknowledgedAt) {
        sets.push('acknowledged_at = ?');
        params.push(ts);
      }
      if (status === 'resolved') {
        sets.push('resolved_at = ?');
        params.push(ts);
      } else if (current.resolvedAt) {
        // Re-opened: clear the resolution timestamp.
        sets.push('resolved_at = NULL');
      }
      if (assignedTo !== undefined) {
        sets.push('assigned_to = ?');
        params.push(assignedTo);
      }
      if (resolution !== undefined) {
        sets.push('resolution = ?');
        params.push(resolution);
      }
      this.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      this.db
        .prepare(
          `INSERT INTO ticket_events (ticket_id, kind, status, note, actor, created_at)
           VALUES (?, 'status', ?, ?, ?, ?)`,
        )
        .run(id, status, note, actor, ts);
      return this.getTicket(id);
    });
  }

  addTicketNote(id, { note, actor, kind = 'note' }) {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO ticket_events (ticket_id, kind, status, note, actor, created_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      )
      .run(id, kind, note, actor, ts);
    this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(ts, id);
    return this.getTicket(id);
  }

  // DOWN tickets nobody has acknowledged since before `cutoffIso`.
  listUnacknowledgedDown(cutoffIso) {
    return this.db
      .prepare(
        `${TICKET_SELECT}
         WHERE t.severity = 'down' AND t.status = 'open' AND t.acknowledged_at IS NULL
           AND t.escalated_at IS NULL AND t.created_at <= ?
         ORDER BY t.created_at`,
      )
      .all(cutoffIso)
      .map(mapTicket);
  }

  markEscalated(id) {
    this.db.prepare('UPDATE tickets SET escalated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  // ---------- battery ----------
  findBatteryByClientId(clientId) {
    if (!clientId) return null;
    return mapBattery(this.db.prepare(`${BATTERY_SELECT} WHERE b.client_id = ?`).get(clientId));
  }

  createBatteryEvent(e) {
    const res = this.db
      .prepare(
        `INSERT INTO battery_events (client_id, lift_id, kind, battery_in, battery_out, charge_pct,
           out_charge_pct, hour_meter, notes, reported_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.clientId || null,
        e.liftId,
        e.kind,
        e.batteryIn ?? '',
        e.batteryOut ?? '',
        e.chargePct ?? null,
        e.outChargePct ?? null,
        e.hourMeter ?? null,
        e.notes ?? '',
        e.reportedBy,
        nowIso(),
      );
    return mapBattery(
      this.db.prepare(`${BATTERY_SELECT} WHERE b.id = ?`).get(Number(res.lastInsertRowid)),
    );
  }

  listBatteryEvents({ liftId, limit = 100 } = {}) {
    const where = liftId ? 'WHERE b.lift_id = ?' : '';
    const params = liftId ? [liftId, limit] : [limit];
    return this.db
      .prepare(`${BATTERY_SELECT} ${where} ORDER BY b.created_at DESC, b.id DESC LIMIT ?`)
      .all(...params)
      .map(mapBattery);
  }

  // Per-lift battery health: latest charge, last swap, swaps per day.
  batterySummary(now = Date.now()) {
    const dayAgo = new Date(now - 24 * 3600e3).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 3600e3).toISOString();
    const rows = this.db
      .prepare(
        `SELECT l.id AS lift_id,
           (SELECT MAX(created_at) FROM battery_events b WHERE b.lift_id = l.id AND b.kind = 'change') AS last_change_at,
           (SELECT battery_in FROM battery_events b WHERE b.lift_id = l.id AND b.kind = 'change'
              ORDER BY created_at DESC, id DESC LIMIT 1) AS current_battery,
           (SELECT COUNT(*) FROM battery_events b WHERE b.lift_id = l.id AND b.kind = 'change' AND b.created_at >= ?) AS changes_24h,
           (SELECT COUNT(*) FROM battery_events b WHERE b.lift_id = l.id AND b.kind = 'change' AND b.created_at >= ?) AS changes_7d
         FROM lifts l WHERE l.active = 1`,
      )
      .all(dayAgo, weekAgo);
    const byLift = new Map(rows.map((r) => [r.lift_id, r]));
    return this.listLifts().map((lift) => {
      const r = byLift.get(lift.id) ?? {};
      return {
        liftId: lift.id,
        unit: lift.unit,
        type: lift.type,
        typeLabel: lift.typeLabel,
        power: lift.power,
        status: lift.status,
        lastCharge: lift.lastCharge,
        lastChangeAt: r.last_change_at ?? null,
        currentBattery: r.current_battery ?? '',
        changes24h: Number(r.changes_24h ?? 0),
        changes7d: Number(r.changes_7d ?? 0),
      };
    });
  }

  // Where every battery ID was last seen, derived from swap history.
  batteryInventory() {
    const events = this.db
      .prepare(
        `${BATTERY_SELECT} WHERE b.kind = 'change' AND (b.battery_in != '' OR b.battery_out != '')
         ORDER BY b.created_at, b.id`,
      )
      .all()
      .map(mapBattery);
    const seen = new Map();
    for (const e of events) {
      if (e.batteryOut) {
        seen.set(e.batteryOut.toUpperCase(), {
          battery: e.batteryOut,
          state: 'out',
          unit: e.unit,
          chargePct: e.outChargePct,
          at: e.createdAt,
        });
      }
      if (e.batteryIn) {
        seen.set(e.batteryIn.toUpperCase(), {
          battery: e.batteryIn,
          state: 'in_lift',
          unit: e.unit,
          chargePct: e.chargePct,
          at: e.createdAt,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.battery.localeCompare(b.battery, undefined, { numeric: true }));
  }

  // ---------- contacts ----------
  listContacts() {
    return this.db.prepare('SELECT * FROM contacts ORDER BY name').all().map(mapContact);
  }

  getContact(id) {
    return mapContact(this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
  }

  createContact({ name, role = '', email = '', phone = '', webhookUrl = '', active = true }) {
    const res = this.db
      .prepare(
        `INSERT INTO contacts (name, role, email, phone, webhook_url, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, role, email, phone, webhookUrl, active ? 1 : 0, nowIso());
    return this.getContact(Number(res.lastInsertRowid));
  }

  updateContact(id, { name, role, email, phone, webhookUrl, active }) {
    this.db
      .prepare(
        `UPDATE contacts SET name = ?, role = ?, email = ?, phone = ?, webhook_url = ?, active = ?
         WHERE id = ?`,
      )
      .run(name, role, email, phone, webhookUrl, active ? 1 : 0, id);
    return this.getContact(id);
  }

  deleteContact(id) {
    transaction(this.db, () => {
      // Remove the contact from every rule that references it.
      for (const rule of this.listRules()) {
        if (rule.contactIds.includes(id)) {
          this.db
            .prepare('UPDATE alert_rules SET contact_ids = ? WHERE id = ?')
            .run(JSON.stringify(rule.contactIds.filter((c) => c !== id)), rule.id);
        }
      }
      this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    });
  }

  // ---------- alert rules ----------
  listRules() {
    return this.db.prepare('SELECT * FROM alert_rules ORDER BY id').all().map(mapRule);
  }

  getRule(id) {
    return mapRule(this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id));
  }

  #ruleParams(r) {
    return [
      r.name,
      r.enabled ? 1 : 0,
      JSON.stringify(r.eventTypes ?? []),
      JSON.stringify(r.liftTypes ?? []),
      JSON.stringify(r.categories ?? []),
      JSON.stringify(r.severities ?? []),
      JSON.stringify(r.days ?? []),
      r.timeStart ?? '',
      r.timeEnd ?? '',
      JSON.stringify(r.contactIds ?? []),
      JSON.stringify(r.channels ?? []),
    ];
  }

  createRule(rule) {
    const res = this.db
      .prepare(
        `INSERT INTO alert_rules (name, enabled, event_types, lift_types, categories, severities, days,
           time_start, time_end, contact_ids, channels, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...this.#ruleParams(rule), nowIso());
    return this.getRule(Number(res.lastInsertRowid));
  }

  updateRule(id, rule) {
    this.db
      .prepare(
        `UPDATE alert_rules SET name = ?, enabled = ?, event_types = ?, lift_types = ?, categories = ?,
           severities = ?, days = ?, time_start = ?, time_end = ?, contact_ids = ?, channels = ?
         WHERE id = ?`,
      )
      .run(...this.#ruleParams(rule), id);
    return this.getRule(id);
  }

  deleteRule(id) {
    this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  }

  // ---------- notifications ----------
  insertNotification(n) {
    const res = this.db
      .prepare(
        `INSERT INTO notifications (event_type, ref_type, ref_id, contact_id, contact_name, channel,
           destination, subject, body, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n.eventType,
        n.refType,
        n.refId ?? null,
        n.contactId ?? null,
        n.contactName ?? '',
        n.channel,
        n.destination ?? '',
        n.subject ?? '',
        n.body ?? '',
        n.status,
        n.error ?? '',
        nowIso(),
      );
    return Number(res.lastInsertRowid);
  }

  setNotificationStatus(id, status, error = '') {
    this.db.prepare('UPDATE notifications SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  }

  listNotifications({ limit = 200, refType, refId } = {}) {
    const where = [];
    const params = [];
    if (refType) {
      where.push('ref_type = ?');
      params.push(refType);
    }
    if (refId) {
      where.push('ref_id = ?');
      params.push(refId);
    }
    return this.db
      .prepare(
        `SELECT * FROM notifications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(mapNotification);
  }

  // ---------- NFC tags / barcodes ----------
  listTags() {
    return this.db
      .prepare('SELECT * FROM tags ORDER BY kind, ref')
      .all()
      .map((r) => ({ id: r.id, uid: r.uid, kind: r.kind, ref: r.ref, createdAt: r.created_at }));
  }

  // Matches "04:A2:3B" against "04A23B" too (keyboard-style readers drop the colons).
  getTagByUid(uid) {
    if (!uid) return null;
    const compact = uid.replace(/:/g, '');
    const r = this.db
      .prepare(`SELECT * FROM tags WHERE uid = ? COLLATE NOCASE OR REPLACE(uid, ':', '') = ? COLLATE NOCASE`)
      .get(uid, compact);
    return r ? { id: r.id, uid: r.uid, kind: r.kind, ref: r.ref, createdAt: r.created_at } : null;
  }

  // Re-registering a tag moves it to the new lift/battery/person.
  saveTag({ uid, kind, ref }) {
    this.db
      .prepare(
        `INSERT INTO tags (uid, kind, ref, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET kind = excluded.kind, ref = excluded.ref`,
      )
      .run(uid, kind, ref, nowIso());
    return this.getTagByUid(uid);
  }

  deleteTag(id) {
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  // ---------- reporting ----------
  // Response and downtime numbers per lift type for tickets opened in the last `days`.
  stats({ days = 30, now = Date.now() } = {}) {
    const since = new Date(now - days * 24 * 3600e3).toISOString();
    const tickets = this.db
      .prepare(`${TICKET_SELECT} WHERE t.created_at >= ?`)
      .all(since)
      .map(mapTicket);
    const groups = new Map();
    const bucket = (key) => {
      if (!groups.has(key)) {
        groups.set(key, { tickets: 0, down: 0, open: 0, ackMins: [], fixMins: [], downHours: 0, categories: {} });
      }
      return groups.get(key);
    };
    const mins = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
    for (const t of tickets) {
      for (const g of [bucket(t.liftType), bucket('all')]) {
        g.tickets += 1;
        if (t.severity === 'down') g.down += 1;
        if (t.status !== 'resolved') g.open += 1;
        if (t.acknowledgedAt) g.ackMins.push(mins(t.createdAt, t.acknowledgedAt));
        if (t.resolvedAt) g.fixMins.push(mins(t.createdAt, t.resolvedAt));
        if (t.severity === 'down') {
          g.downHours += mins(t.createdAt, t.resolvedAt ?? new Date(now).toISOString()) / 60;
        }
        g.categories[t.category] = (g.categories[t.category] ?? 0) + 1;
      }
    }
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
    const out = {};
    for (const [key, g] of groups) {
      out[key] = {
        tickets: g.tickets,
        down: g.down,
        open: g.open,
        avgMinutesToAcknowledge: avg(g.ackMins),
        avgMinutesToResolve: avg(g.fixMins),
        downHours: Math.round(g.downHours * 10) / 10,
        topCategories: Object.entries(g.categories)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([category, count]) => ({ category, label: CATEGORY[category]?.label ?? category, count })),
      };
    }
    return { days, since, byLiftType: out };
  }
}
