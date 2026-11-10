import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lifts (
  id          INTEGER PRIMARY KEY,
  unit        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type        TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  serial      TEXT NOT NULL DEFAULT '',
  zone        TEXT NOT NULL DEFAULT '',
  power       TEXT NOT NULL DEFAULT 'lead_acid',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id              INTEGER PRIMARY KEY,
  client_id       TEXT UNIQUE,
  lift_id         INTEGER NOT NULL REFERENCES lifts(id),
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  error_code      TEXT NOT NULL DEFAULT '',
  reported_by     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  assigned_to     TEXT NOT NULL DEFAULT '',
  resolution      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at     TEXT,
  escalated_at    TEXT
);
CREATE INDEX IF NOT EXISTS tickets_lift_status ON tickets(lift_id, status);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, severity);

CREATE TABLE IF NOT EXISTS ticket_events (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- reported | status | note | escalated
  status     TEXT,
  note       TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events(ticket_id);

CREATE TABLE IF NOT EXISTS ticket_photos (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS battery_events (
  id             INTEGER PRIMARY KEY,
  client_id      TEXT UNIQUE,
  lift_id        INTEGER NOT NULL REFERENCES lifts(id),
  kind           TEXT NOT NULL,        -- change | charge
  battery_in     TEXT NOT NULL DEFAULT '',
  battery_out    TEXT NOT NULL DEFAULT '',
  charge_pct     INTEGER,              -- charge of the battery now in the lift
  out_charge_pct INTEGER,              -- charge left on the battery removed
  hour_meter     REAL,
  notes          TEXT NOT NULL DEFAULT '',
  reported_by    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS battery_events_lift ON battery_events(lift_id, created_at);

CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  event_types TEXT NOT NULL DEFAULT '[]',  -- JSON arrays; [] means "any"
  lift_types  TEXT NOT NULL DEFAULT '[]',
  categories  TEXT NOT NULL DEFAULT '[]',
  severities  TEXT NOT NULL DEFAULT '[]',
  days        TEXT NOT NULL DEFAULT '[]',  -- 0=Sun..6=Sat
  time_start  TEXT NOT NULL DEFAULT '',    -- 'HH:MM' local, '' = all day
  time_end    TEXT NOT NULL DEFAULT '',
  contact_ids TEXT NOT NULL DEFAULT '[]',
  channels    TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY,
  event_type   TEXT NOT NULL,
  ref_type     TEXT NOT NULL,           -- ticket | battery | test
  ref_id       INTEGER,
  contact_id   INTEGER,
  contact_name TEXT NOT NULL DEFAULT '',
  channel      TEXT NOT NULL,
  destination  TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,           -- pending | sent | logged | skipped | failed
  error        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at);

-- NFC tags / barcodes registered to a lift, battery or person (badge).
-- uid is the NFC serial number (e.g. 04:A2:3B:1C:5D:80) or a barcode value.
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY,
  uid        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT NOT NULL,            -- lift | battery | person
  ref        TEXT NOT NULL,            -- lift unit, battery number or person name
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// Run `fn` inside a transaction; rolls back on throw.
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
