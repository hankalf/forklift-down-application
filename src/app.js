import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { catalog, LIFT_TYPE } from './catalog.js';
import { createAuth } from './auth.js';
import { deliveryStatus } from './config.js';
import { HttpError, cleanContact, cleanLift, cleanRule, cleanTag, createService, str } from './service.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ store, notifier, config }) {
  const app = express();
  const auth = createAuth(config);
  const service = createService({ store, notifier, config });
  app.locals = { ...app.locals, store, notifier, service, auth, config };

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Ticket links carry an access token; never leak it to other sites.
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '10mb' }));

  // Railway (and other hosts) health check: also proves the database answers.
  app.get('/healthz', (req, res) => {
    store.db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  const id = (req) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
    return n;
  };

  // ---------------- worker (no login) ----------------
  app.get('/api/config', (req, res) => {
    const settings = store.getSettings();
    res.json({
      ...catalog(),
      siteName: settings.siteName,
      lowChargePct: settings.lowChargePct,
      managerProtected: auth.protectedMode,
      devicePinRequired: auth.devicePinRequired,
    });
  });

  // One-time site PIN per worker device (only when WORKER_PIN is set).
  app.get('/api/device/session', (req, res) => {
    res.json({ required: auth.devicePinRequired, enrolled: auth.isDevice(req) });
  });

  app.post('/api/device/login', (req, res) => {
    if (!auth.devicePinRequired) return res.json({ enrolled: true });
    const result = auth.checkPin(req, req.body?.pin, config.workerPin);
    if (!result.ok) {
      const msg = result.retryAfterSec
        ? `Too many wrong PINs. Try again in ${Math.ceil(result.retryAfterSec / 60)} min.`
        : 'Wrong PIN — ask your supervisor for the site PIN';
      return res.status(result.retryAfterSec ? 429 : 401).json({ error: msg });
    }
    auth.setDeviceCookie(res, req);
    res.json({ enrolled: true });
  });

  app.get('/api/lifts', auth.requireDevice, (req, res) => {
    res.json(store.listLifts());
  });

  app.get('/api/lifts/:unit', auth.requireDevice, (req, res) => {
    const lift = store.getLiftByUnit(req.params.unit);
    if (!lift || !lift.active) throw new HttpError(404, `No lift with unit number "${req.params.unit}"`);
    res.json({
      ...lift,
      openTickets: store.listTickets({ status: 'open', liftId: lift.id }),
      recentBattery: store.listBatteryEvents({ liftId: lift.id, limit: 5 }),
    });
  });

  app.post('/api/tickets', auth.requireDevice, (req, res) => {
    const result = service.reportIssue(req.body ?? {});
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.post('/api/tickets/:id/notes', auth.requireDevice, (req, res) => {
    res.json({ ticket: service.addNote(id(req), req.body ?? {}) });
  });

  // NFC tag / barcode → lift, battery or person.
  app.post('/api/scan', auth.requireDevice, (req, res) => {
    res.json(service.resolveScan(req.body ?? {}));
  });

  app.post('/api/battery', auth.requireDevice, (req, res) => {
    const result = service.logBattery(req.body ?? {});
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  // ---------------- ticket page (manager or alert link) ----------------
  app.get('/api/tickets/:id', auth.requireTicketAccess, (req, res) => {
    const ticket = store.getTicketDetail(id(req));
    if (!ticket) throw new HttpError(404, 'Ticket not found');
    res.json({
      ticket,
      lift: store.getLift(ticket.liftId),
      notifications: store.listNotifications({ refType: 'ticket', refId: ticket.id, limit: 100 }),
      ticketStatuses: catalog().ticketStatuses,
    });
  });

  app.post('/api/tickets/:id/status', auth.requireTicketAccess, (req, res) => {
    res.json(service.updateStatus(id(req), req.body ?? {}));
  });

  // ---------------- manager ----------------
  app.get('/api/manager/session', (req, res) => {
    const loggedIn = auth.isManager(req);
    res.json({
      protected: auth.protectedMode,
      loggedIn,
      delivery: loggedIn ? deliveryStatus(config) : undefined,
    });
  });

  app.post('/api/manager/login', (req, res) => {
    if (!auth.protectedMode) return res.json({ loggedIn: true });
    const result = auth.checkPin(req, req.body?.pin);
    if (!result.ok) {
      const msg = result.retryAfterSec
        ? `Too many wrong PINs. Try again in ${Math.ceil(result.retryAfterSec / 60)} min.`
        : 'Wrong PIN';
      return res.status(result.retryAfterSec ? 429 : 401).json({ error: msg });
    }
    auth.setSessionCookie(res, req);
    res.json({ loggedIn: true });
  });

  app.post('/api/manager/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ loggedIn: false });
  });

  const mgr = express.Router();
  mgr.use(auth.requireManager);

  mgr.get('/board', (req, res) => {
    const lifts = store.listLifts();
    const counts = { down: 0, repair: 0, available: 0 };
    const byType = {};
    for (const l of lifts) {
      counts[l.status] += 1;
      byType[l.type] ??= { down: 0, repair: 0, available: 0, total: 0 };
      byType[l.type][l.status] += 1;
      byType[l.type].total += 1;
    }
    res.json({ lifts, counts, byType, tickets: store.listTickets({ status: 'open' }), settings: store.getSettings() });
  });

  mgr.get('/tickets', (req, res) => {
    const status = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
    res.json(store.listTickets({ status, limit: Math.min(Number(req.query.limit) || 200, 1000) }));
  });

  mgr.get('/battery', (req, res) => {
    res.json({
      summary: store.batterySummary(),
      inventory: store.batteryInventory(),
      events: store.listBatteryEvents({ limit: 100 }),
      settings: store.getSettings(),
    });
  });

  mgr.get('/notifications', (req, res) => {
    res.json(store.listNotifications({ limit: Math.min(Number(req.query.limit) || 200, 1000) }));
  });

  mgr.get('/stats', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.json(store.stats({ days }));
  });

  mgr.get('/export/tickets.csv', (req, res) => {
    const rows = store.listTickets({ status: 'all', limit: 100000 });
    const mins = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : '');
    const header = [
      'ticket', 'unit', 'lift_type', 'category', 'severity', 'status', 'reported_by', 'reported_at',
      'acknowledged_at', 'resolved_at', 'minutes_to_acknowledge', 'minutes_to_resolve', 'error_code',
      'description', 'assigned_to', 'resolution',
    ];
    const csvCell = (v) => {
      const s = String(v ?? '');
      // Neutralise spreadsheet formulas and quote everything.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const lines = [header.join(',')];
    for (const t of rows) {
      lines.push(
        [
          t.id, t.unit, t.liftTypeLabel, t.categoryLabel, t.severityLabel, t.statusLabel, t.reportedBy,
          t.createdAt, t.acknowledgedAt, t.resolvedAt, mins(t.createdAt, t.acknowledgedAt),
          mins(t.createdAt, t.resolvedAt), t.errorCode, t.description, t.assignedTo, t.resolution,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="forklift-tickets.csv"');
    res.send(lines.join('\r\n'));
  });

  // Lifts
  mgr.get('/lifts', (req, res) => res.json(store.listLifts({ includeInactive: true })));
  mgr.post('/lifts', (req, res) => res.status(201).json(store.createLift(cleanLift(req.body ?? {}))));
  mgr.put('/lifts/:id', (req, res) => {
    if (!store.getLift(id(req))) throw new HttpError(404, 'Lift not found');
    res.json(store.updateLift(id(req), cleanLift(req.body ?? {})));
  });
  mgr.delete('/lifts/:id', (req, res) => res.json(store.removeLift(id(req))));

  // Contacts
  mgr.get('/contacts', (req, res) => res.json(store.listContacts()));
  mgr.post('/contacts', (req, res) => res.status(201).json(store.createContact(cleanContact(req.body ?? {}))));
  mgr.put('/contacts/:id', (req, res) => {
    if (!store.getContact(id(req))) throw new HttpError(404, 'Contact not found');
    res.json(store.updateContact(id(req), cleanContact(req.body ?? {})));
  });
  mgr.delete('/contacts/:id', (req, res) => {
    store.deleteContact(id(req));
    res.json({ deleted: true });
  });
  mgr.post('/contacts/:id/test', async (req, res) => {
    const contact = store.getContact(id(req));
    if (!contact) throw new HttpError(404, 'Contact not found');
    const channels = await notifier.sendTest(contact);
    if (!channels.length) throw new HttpError(400, 'Add a phone, email or webhook for this person first');
    const results = store.listNotifications({ refType: 'test', limit: channels.length });
    res.json({ channels, results });
  });

  // Rules
  mgr.get('/rules', (req, res) => res.json(store.listRules()));
  mgr.post('/rules', (req, res) => {
    res.status(201).json(store.createRule(cleanRule(req.body ?? {}, { contacts: store.listContacts() })));
  });
  mgr.put('/rules/:id', (req, res) => {
    if (!store.getRule(id(req))) throw new HttpError(404, 'Rule not found');
    res.json(store.updateRule(id(req), cleanRule(req.body ?? {}, { contacts: store.listContacts() })));
  });
  mgr.delete('/rules/:id', (req, res) => {
    store.deleteRule(id(req));
    res.json({ deleted: true });
  });
  // "If this happened right now, who would be alerted?"
  mgr.post('/rules/preview', (req, res) => {
    const b = req.body ?? {};
    const recipients = notifier.plan({
      type: str(b.eventType, 40) || 'issue_reported',
      liftType: str(b.liftType, 40) || null,
      category: str(b.category, 40) || null,
      severity: str(b.severity, 20) || null,
      at: b.at ? new Date(b.at) : new Date(),
    });
    res.json(
      recipients.map((r) => ({
        contact: r.contact,
        channels: r.channels,
        rules: r.rules,
      })),
    );
  });

  // NFC tags / barcodes
  mgr.get('/tags', (req, res) => res.json(store.listTags()));
  mgr.post('/tags', (req, res) => res.status(201).json(store.saveTag(cleanTag(req.body ?? {}, { store }))));
  mgr.delete('/tags/:id', (req, res) => {
    store.deleteTag(id(req));
    res.json({ deleted: true });
  });

  // Settings
  mgr.get('/settings', (req, res) => res.json(store.getSettings()));
  mgr.put('/settings', (req, res) => {
    const b = req.body ?? {};
    const patch = {};
    if (b.siteName !== undefined) patch.siteName = str(b.siteName, 80) || 'Warehouse';
    if (b.lowChargePct !== undefined) {
      const n = Number(b.lowChargePct);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(400, 'Low charge must be 0–100');
      patch.lowChargePct = n;
    }
    if (b.escalateAfterMinutes !== undefined) {
      const n = Number(b.escalateAfterMinutes);
      if (!Number.isInteger(n) || n < 0 || n > 24 * 60) {
        throw new HttpError(400, 'Escalation minutes must be 0–1440 (0 turns it off)');
      }
      patch.escalateAfterMinutes = n;
    }
    res.json(store.updateSettings(patch));
  });

  app.use('/api/manager', mgr);

  // Printable QR labels — one per lift, scanning opens the report screen for it.
  app.get('/manager/labels', auth.requireManager, async (req, res) => {
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const only = req.query.unit ? String(req.query.unit).toUpperCase() : null;
    const lifts = store.listLifts().filter((l) => !only || l.unit.toUpperCase() === only);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const labels = await Promise.all(
      lifts.map(async (l) => {
        const url = `${base}/l/${encodeURIComponent(l.unit)}`;
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return `<div class="label">
          <div class="unit">${esc(l.unit)}</div>
          <div class="type">${esc(LIFT_TYPE[l.type]?.label ?? l.type)}</div>
          <div class="qr">${svg}</div>
          <div class="cta">Scan to report a problem<br>or log a battery change</div>
        </div>`;
      }),
    );
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Forklift QR labels</title>
      <style>
        body{font-family:system-ui,sans-serif;margin:16px;color:#111}
        .bar{display:flex;gap:12px;align-items:center;margin-bottom:16px}
        .bar button{font-size:16px;padding:8px 16px}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(2.6in,1fr));gap:.25in}
        .label{border:3px solid #111;border-radius:12px;padding:12px;text-align:center;break-inside:avoid}
        .unit{font-size:40px;font-weight:800;letter-spacing:1px}
        .type{font-size:14px;margin-bottom:6px}
        .qr svg{width:1.8in;height:1.8in}
        .cta{font-size:13px;font-weight:600}
        @media print{.bar{display:none}body{margin:0}}
      </style></head><body>
      <div class="bar"><button onclick="print()">Print labels</button>
      <span>${lifts.length} label(s) · links point to ${esc(base)}</span></div>
      <div class="grid">${labels.join('')}</div></body></html>`);
  });

  // ---------------- pages & static ----------------
  app.get('/l/:unit', (req, res) => res.redirect(`/?lift=${encodeURIComponent(req.params.unit)}`));
  // Battery NFC tags carry /b/<battery number>; the app works out which lift it is in.
  app.get('/b/:battery', (req, res) => res.redirect(`/?scan=${encodeURIComponent(`battery:${req.params.battery}`)}`));
  app.get('/t/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'ticket.html')));
  app.get('/manager', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'manager.html')));
  app.use(
    '/uploads',
    express.static(config.uploadsDir, {
      index: false,
      setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'"),
    }),
  );
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders: (res, file) => {
        // Always revalidate the app shell so updates reach phones quickly.
        if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (/UNIQUE constraint failed: lifts\.unit/.test(err.message)) {
      return res.status(409).json({ error: 'A lift with that unit number already exists' });
    }
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });

  return app;
}
