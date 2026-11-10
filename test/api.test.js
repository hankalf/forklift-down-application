import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startTestServer } from './helpers.js';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const names = (list) => list.map((r) => r.name).sort();

describe('worker reporting flow', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    t.giveContactsAddresses();
  });
  after(() => t.close());
  beforeEach(() => {
    t.sent.length = 0;
  });

  it('serves the catalog with the three lift types', async () => {
    const { status, data } = await t.api('GET', '/api/config');
    assert.equal(status, 200);
    assert.deepEqual(
      data.liftTypes.map((l) => l.key),
      ['raymond_reach', 'linde_reach', 'dock'],
    );
    assert.ok(data.categories.length > 5);
  });

  it('lists the demo fleet as available', async () => {
    const { data } = await t.api('GET', '/api/lifts');
    assert.equal(data.length, 16);
    assert.ok(data.every((l) => l.status === 'available'));
  });

  it('reports a DOWN Raymond with brakes and alerts by lift type + issue', async () => {
    const { status, data } = await t.api('POST', '/api/tickets', {
      clientId: 'abc-1',
      unit: 'r-03',
      category: 'brakes',
      severity: 'down',
      description: 'Brakes grabbing',
      errorCode: 'E-123',
      reportedBy: 'Maria',
    });
    assert.equal(status, 201);
    assert.equal(data.ticket.unit, 'R-03');
    assert.equal(data.ticket.status, 'open');
    assert.deepEqual(names(data.notified), [
      'Maintenance Lead',
      'Raymond Dealer Service',
      'Safety Coordinator',
      'Shift Team Channel',
      'Warehouse Manager',
    ]);

    await t.notifier.flush();
    const sms = t.sent.filter((s) => s.channel === 'sms');
    assert.ok(sms.length >= 3);
    assert.match(sms[0].sms, /LIFT DOWN: R-03 \(Raymond High Reach Truck/);
    assert.match(sms[0].sms, /https:\/\/lifts\.test\/t\/\d+\?k=/);
    const hook = t.sent.find((s) => s.channel === 'webhook');
    assert.match(hook.subject, /\[DOWN\] R-03/);

    const lift = await t.api('GET', '/api/lifts/R-03');
    assert.equal(lift.data.status, 'down');
    assert.equal(lift.data.openTickets.length, 1);
  });

  it('is idempotent on clientId (offline retries do not double-alert)', async () => {
    const body = { clientId: 'dup-1', unit: 'L-01', category: 'hydraulics', severity: 'repair', reportedBy: 'Sam' };
    const first = await t.api('POST', '/api/tickets', body);
    await t.notifier.flush();
    const sentAfterFirst = t.sent.length;
    const second = await t.api('POST', '/api/tickets', body);
    await t.notifier.flush();
    assert.equal(second.status, 200);
    assert.equal(second.data.duplicate, true);
    assert.equal(second.data.ticket.id, first.data.ticket.id);
    assert.equal(t.sent.length, sentAfterFirst);
  });

  it('routes a Linde "needs repair" to maintenance + Linde dealer only', async () => {
    const { data } = await t.api('POST', '/api/tickets', {
      unit: 'L-02',
      category: 'hydraulics',
      severity: 'repair',
      reportedBy: 'Sam',
    });
    assert.deepEqual(names(data.notified), ['Linde Dealer Service', 'Maintenance Lead', 'Shift Team Channel']);
    const lift = await t.api('GET', '/api/lifts/L-02');
    assert.equal(lift.data.status, 'repair');
  });

  it('routes dock truck problems to the dock supervisor', async () => {
    const { data } = await t.api('POST', '/api/tickets', {
      unit: 'D-01',
      category: 'wheels',
      severity: 'repair',
      reportedBy: 'Lee',
    });
    assert.ok(names(data.notified).includes('Dock Supervisor'));
    assert.ok(!names(data.notified).includes('Raymond Dealer Service'));
  });

  it('validates input', async () => {
    let r = await t.api('POST', '/api/tickets', { unit: 'R-01', category: 'brakes', severity: 'down' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /name/i);
    r = await t.api('POST', '/api/tickets', { unit: 'NOPE', category: 'brakes', severity: 'down', reportedBy: 'Al' });
    assert.equal(r.status, 404);
    r = await t.api('POST', '/api/tickets', { unit: 'R-01', category: 'lasers', severity: 'down', reportedBy: 'Al' });
    assert.equal(r.status, 400);
  });

  it('stores a photo and rejects non-images', async () => {
    const ok = await t.api('POST', '/api/tickets', {
      unit: 'R-05',
      category: 'damage',
      severity: 'repair',
      reportedBy: 'Al',
      photo: PNG_1PX,
    });
    assert.equal(ok.status, 201);
    const detail = t.store.getTicketDetail(ok.data.ticket.id);
    assert.equal(detail.photos.length, 1);
    const img = await fetch(t.base + detail.photos[0]);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');

    const bad = await t.api('POST', '/api/tickets', {
      unit: 'R-05',
      category: 'damage',
      severity: 'repair',
      reportedBy: 'Al',
      photo: 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'),
    });
    assert.equal(bad.status, 400);
  });

  it('lets a worker add a "me too" note to an open ticket', async () => {
    const { data } = await t.api('POST', '/api/tickets', {
      unit: 'R-06',
      category: 'steering',
      severity: 'repair',
      reportedBy: 'Al',
    });
    const r = await t.api('POST', `/api/tickets/${data.ticket.id}/notes`, { note: 'Pulling left too', actor: 'Bo' });
    assert.equal(r.status, 200);
    const detail = t.store.getTicketDetail(data.ticket.id);
    assert.equal(detail.events.at(-1).note, 'Pulling left too');
  });
});

describe('tech ticket links and status workflow', () => {
  let t;
  before(async () => {
    t = await startTestServer({ managerPin: '4321' });
    t.giveContactsAddresses();
  });
  after(() => t.close());

  it('opens a ticket from the alert link without logging in, but not without the token', async () => {
    const { data } = await t.api('POST', '/api/tickets', {
      unit: 'R-01',
      category: 'hydraulics',
      severity: 'down',
      reportedBy: 'Maria',
    });
    const id = data.ticket.id;
    await t.notifier.flush();
    const link = t.sent.find((s) => s.channel === 'sms').link;
    const k = new URL(link).searchParams.get('k');

    assert.equal((await t.api('GET', `/api/tickets/${id}`)).status, 401);
    assert.equal((await t.api('GET', `/api/tickets/${id}?k=wrong`)).status, 401);
    assert.equal((await t.api('GET', `/api/tickets/${id + 1}?k=${k}`)).status, 401);
    const view = await t.api('GET', `/api/tickets/${id}?k=${k}`);
    assert.equal(view.status, 200);
    assert.equal(view.data.ticket.id, id);
    assert.ok(view.data.notifications.length > 0);

    const ack = await t.api('POST', `/api/tickets/${id}/status?k=${k}`, {
      status: 'acknowledged',
      actor: 'Tech Tom',
      assignedTo: 'Tech Tom',
    });
    assert.equal(ack.status, 200);
    assert.ok(ack.data.ticket.acknowledgedAt);
    assert.equal(ack.data.ticket.assignedTo, 'Tech Tom');

    const noFix = await t.api('POST', `/api/tickets/${id}/status?k=${k}`, { status: 'resolved', actor: 'Tech Tom' });
    assert.equal(noFix.status, 400);

    t.sent.length = 0;
    const fixed = await t.api('POST', `/api/tickets/${id}/status?k=${k}`, {
      status: 'resolved',
      actor: 'Tech Tom',
      resolution: 'Replaced lift cylinder seal',
    });
    assert.equal(fixed.status, 200);
    assert.ok(fixed.data.ticket.resolvedAt);
    assert.ok(names(fixed.data.notified).includes('Warehouse Manager'));
    await t.notifier.flush();
    assert.match(t.sent.find((s) => s.channel === 'email').text, /BACK IN SERVICE: R-01/);

    const lift = await t.api('GET', '/api/lifts/R-01');
    assert.equal(lift.data.status, 'available');
  });

  it('escalates unacknowledged DOWN tickets once, and skips acknowledged ones', async () => {
    const a = await t.api('POST', '/api/tickets', { unit: 'L-03', category: 'drive', severity: 'down', reportedBy: 'X1' });
    const b = await t.api('POST', '/api/tickets', { unit: 'L-04', category: 'drive', severity: 'down', reportedBy: 'X2' });
    const c = await t.api('POST', '/api/tickets', { unit: 'L-05', category: 'drive', severity: 'repair', reportedBy: 'X3' });
    t.store.updateTicketStatus(b.data.ticket.id, { status: 'acknowledged', actor: 'Tom' });

    const { service } = t.app.locals;
    assert.deepEqual(service.runEscalation(Date.now()), [], 'not yet due');
    t.sent.length = 0;
    const escalated = service.runEscalation(Date.now() + 16 * 60e3);
    assert.deepEqual(escalated, [a.data.ticket.id]);
    assert.ok(!escalated.includes(c.data.ticket.id));
    await t.notifier.flush();
    const toOps = t.sent.filter((s) => s.to.includes('operations.manager'));
    assert.equal(toOps.length, 1);
    assert.match(toOps[0].subject, /ESCALATION/);
    assert.deepEqual(service.runEscalation(Date.now() + 60 * 60e3), [], 'only escalates once');
  });
});

describe('battery changes and charge levels', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    t.giveContactsAddresses();
  });
  after(() => t.close());

  it('alerts the battery room on low charge only', async () => {
    const ok = await t.api('POST', '/api/battery', { unit: 'R-02', kind: 'charge', chargePct: 80, reportedBy: 'Jose' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.lowCharge, false);
    assert.deepEqual(ok.data.notified, []);

    const low = await t.api('POST', '/api/battery', { unit: 'R-02', kind: 'charge', chargePct: 15, reportedBy: 'Jose' });
    assert.equal(low.data.lowCharge, true);
    assert.deepEqual(names(low.data.notified), ['Battery Room']);

    const lift = await t.api('GET', '/api/lifts/R-02');
    assert.equal(lift.data.lastCharge.pct, 15);
  });

  it('records battery swaps and tracks where each battery is', async () => {
    const r = await t.api('POST', '/api/battery', {
      clientId: 'swap-1',
      unit: 'L-01',
      kind: 'change',
      batteryOut: 'B-07',
      outChargePct: 18,
      batteryIn: 'B-12',
      chargePct: 100,
      hourMeter: 5123.4,
      reportedBy: 'Jose',
    });
    assert.equal(r.status, 201);
    const dup = await t.api('POST', '/api/battery', { clientId: 'swap-1', unit: 'L-01', kind: 'change', reportedBy: 'Jose' });
    assert.equal(dup.data.duplicate, true);

    t.clearCookie();
    const { data } = await t.api('GET', '/api/manager/battery');
    const l01 = data.summary.find((s) => s.unit === 'L-01');
    assert.equal(l01.currentBattery, 'B-12');
    assert.equal(l01.changes24h, 1);
    assert.equal(l01.lastCharge.pct, 100);
    const inv = Object.fromEntries(data.inventory.map((b) => [b.battery, b]));
    assert.equal(inv['B-12'].state, 'in_lift');
    assert.equal(inv['B-07'].state, 'out');
    assert.equal(inv['B-07'].chargePct, 18);
  });

  it('rejects bad charge values', async () => {
    const r = await t.api('POST', '/api/battery', { unit: 'R-01', kind: 'charge', chargePct: 140, reportedBy: 'Jose' });
    assert.equal(r.status, 400);
    const r2 = await t.api('POST', '/api/battery', { unit: 'R-01', kind: 'charge', reportedBy: 'Jose' });
    assert.equal(r2.status, 400);
  });
});

describe('manager dashboard and setup', () => {
  let t;
  before(async () => {
    t = await startTestServer({ managerPin: '2468' });
  });
  after(() => t.close());

  it('requires the manager PIN', async () => {
    assert.equal((await t.api('GET', '/api/manager/board')).status, 401);
    assert.equal((await t.api('GET', '/manager/labels')).status, 401);
    assert.equal((await t.api('POST', '/api/manager/login', { pin: '0000' })).status, 401);
    assert.equal((await t.api('POST', '/api/manager/login', { pin: '2468' })).status, 200);
    const board = await t.api('GET', '/api/manager/board');
    assert.equal(board.status, 200);
    assert.equal(board.data.counts.available, 16);
    assert.equal(board.data.byType.raymond_reach.total, 6);
  });

  it('records skipped alerts when contacts have no address yet', async () => {
    const r = await t.api('POST', '/api/tickets', { unit: 'D-02', category: 'brakes', severity: 'down', reportedBy: 'Al' });
    assert.deepEqual(r.data.notified, [], 'worker is not told people were alerted when nobody could be');
    await t.notifier.flush();
    const { data } = await t.api('GET', '/api/manager/notifications');
    assert.ok(data.length > 0);
    assert.ok(data.every((n) => n.status === 'skipped'));
  });

  it('creates rules, validates them and previews who gets alerted', async () => {
    const contacts = (await t.api('GET', '/api/manager/contacts')).data;
    const created = await t.api('POST', '/api/manager/contacts', {
      name: 'Night Tech',
      phone: '+1 (555) 222-3333',
      email: 'night@example.com',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.phone, '+15552223333');
    assert.equal((await t.api('POST', '/api/manager/contacts', { name: 'X', phone: '555-1234' })).status, 400);

    const bad = await t.api('POST', '/api/manager/rules', { name: 'No one', contactIds: [], channels: ['sms'] });
    assert.equal(bad.status, 400);

    const rule = await t.api('POST', '/api/manager/rules', {
      name: 'Linde hydraulics at night → night tech',
      eventTypes: ['issue_reported'],
      liftTypes: ['linde_reach'],
      categories: ['hydraulics'],
      timeStart: '22:00',
      timeEnd: '06:00',
      contactIds: [created.data.id],
      channels: ['sms'],
    });
    assert.equal(rule.status, 201);

    const night = new Date();
    night.setHours(23, 30, 0, 0);
    const preview = await t.api('POST', '/api/manager/rules/preview', {
      eventType: 'issue_reported',
      liftType: 'linde_reach',
      category: 'hydraulics',
      severity: 'repair',
      at: night.toISOString(),
    });
    const who = preview.data.map((p) => p.contact.name);
    assert.ok(who.includes('Night Tech'));
    assert.ok(who.includes('Linde Dealer Service'));
    assert.ok(contacts.length >= 9);

    const day = new Date();
    day.setHours(12, 0, 0, 0);
    const dayPreview = await t.api('POST', '/api/manager/rules/preview', {
      eventType: 'issue_reported',
      liftType: 'linde_reach',
      category: 'hydraulics',
      severity: 'repair',
      at: day.toISOString(),
    });
    assert.ok(!dayPreview.data.some((p) => p.contact.name === 'Night Tech'));
  });

  it('manages lifts: duplicates rejected, lifts with history retired not deleted', async () => {
    const created = await t.api('POST', '/api/manager/lifts', { unit: 'R-20', type: 'raymond_reach', zone: 'Aisle 30' });
    assert.equal(created.status, 201);
    assert.equal((await t.api('POST', '/api/manager/lifts', { unit: 'r-20', type: 'dock' })).status, 409);
    assert.equal((await t.api('POST', '/api/manager/lifts', { unit: 'X-1', type: 'spaceship' })).status, 400);
    assert.deepEqual((await t.api('DELETE', `/api/manager/lifts/${created.data.id}`)).data, { deleted: true });

    const d02 = t.store.getLiftByUnit('D-02');
    assert.deepEqual((await t.api('DELETE', `/api/manager/lifts/${d02.id}`)).data, { retired: true });
    assert.equal((await t.api('GET', '/api/lifts/D-02')).status, 404);
  });

  it('updates settings and uses them for low-charge alerts', async () => {
    const s = await t.api('PUT', '/api/manager/settings', { lowChargePct: 30, siteName: 'DC 4' });
    assert.equal(s.data.lowChargePct, 30);
    const r = await t.api('POST', '/api/battery', { unit: 'R-04', kind: 'charge', chargePct: 25, reportedBy: 'Jose' });
    assert.equal(r.data.lowCharge, true);
    assert.equal((await t.api('PUT', '/api/manager/settings', { lowChargePct: 300 })).status, 400);
  });

  it('prints QR labels, exports CSV and reports stats', async () => {
    const labels = await t.api('GET', '/manager/labels?unit=R-01');
    assert.equal(labels.status, 200);
    assert.match(labels.data, /<svg/);
    assert.match(labels.data, /R-01/);

    const csv = await t.api('GET', '/api/manager/export/tickets.csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.data, /^ticket,unit,lift_type/);
    assert.match(csv.data, /"D-02"/);

    const stats = await t.api('GET', '/api/manager/stats');
    assert.equal(stats.data.byLiftType.all.tickets, 1);
    assert.equal(stats.data.byLiftType.dock.down, 1);
  });

  it('sends a test alert to a contact', async () => {
    const contact = t.store.listContacts().find((c) => c.name === 'Night Tech');
    const r = await t.api('POST', `/api/manager/contacts/${contact.id}/test`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.channels.sort(), ['email', 'sms']);
  });
});

describe('NFC tags and scanner input', () => {
  let t;
  before(async () => {
    t = await startTestServer({ managerPin: '1111' });
    await t.api('POST', '/api/manager/login', { pin: '1111' });
  });
  after(() => t.close());

  const scan = (body) => t.api('POST', '/api/scan', body).then((r) => r.data);

  it('reads lift and battery links written on tags, prefixes, and our QR label URLs', async () => {
    assert.equal((await scan({ serial: '04:aa:bb:cc', text: 'https://forklift.up.railway.app/l/R-03' })).ref, 'R-03');
    assert.equal((await scan({ text: 'https://forklift.up.railway.app/l/r-03' })).lift.unit, 'R-03');
    assert.equal((await scan({ text: 'lift:L-02' })).kind, 'lift');
    const bat = await scan({ text: 'https://forklift.up.railway.app/b/B-12' });
    assert.deepEqual([bat.kind, bat.ref, bat.location], ['battery', 'B-12', null]);
    assert.deepEqual(await scan({ text: 'person:Maria Lopez' }), { kind: 'person', ref: 'Maria Lopez' });
  });

  it('treats a plain barcode of a unit number as that lift', async () => {
    const r = await scan({ text: 'D-04' });
    assert.equal(r.kind, 'lift');
    assert.equal(r.ref, 'D-04');
  });

  it('looks up registered tag serial numbers, in any colon/case format', async () => {
    assert.equal((await scan({ serial: '04:a1:b2:c3:d4:e5:f6' })).kind, 'unknown');
    const reg = await t.api('POST', '/api/manager/tags', { uid: '04:a1:b2:c3:d4:e5:f6', kind: 'lift', ref: 'l-05' });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.uid, '04:A1:B2:C3:D4:E5:F6');
    assert.equal(reg.data.ref, 'L-05');
    assert.equal((await scan({ serial: '04:A1:B2:C3:D4:E5:F6' })).ref, 'L-05');
    // A keyboard-style reader typing the serial without colons.
    assert.equal((await scan({ text: '04A1B2C3D4E5F6' })).ref, 'L-05');

    await t.api('POST', '/api/manager/tags', { uid: '04:99:88:77', kind: 'person', ref: 'Jose Ruiz' });
    assert.deepEqual(await scan({ serial: '04:99:88:77' }), { kind: 'person', ref: 'Jose Ruiz' });

    // Re-registering moves the tag.
    await t.api('POST', '/api/manager/tags', { uid: '04:a1:b2:c3:d4:e5:f6', kind: 'battery', ref: 'B-30' });
    assert.equal((await scan({ serial: '04:a1:b2:c3:d4:e5:f6' })).kind, 'battery');
    const tags = (await t.api('GET', '/api/manager/tags')).data;
    assert.equal(tags.length, 2);
  });

  it('knows which lift a scanned battery is in', async () => {
    await t.api('POST', '/api/battery', { unit: 'R-02', kind: 'change', batteryOut: 'B-01', batteryIn: 'B-30', chargePct: 100, reportedBy: 'Jose' });
    const r = await scan({ serial: '04:A1:B2:C3:D4:E5:F6' });
    assert.equal(r.location.state, 'in_lift');
    assert.equal(r.location.unit, 'R-02');
  });

  it('validates tag registration and requires the manager', async () => {
    assert.equal((await t.api('POST', '/api/manager/tags', { uid: 'X1', kind: 'lift', ref: 'NOPE' })).status, 400);
    assert.equal((await t.api('POST', '/api/manager/tags', { uid: '', kind: 'lift', ref: 'R-01' })).status, 400);
    assert.equal((await t.api('POST', '/api/manager/tags', { uid: 'X1', kind: 'forklift', ref: 'R-01' })).status, 400);
    t.clearCookie();
    assert.equal((await t.api('GET', '/api/manager/tags')).status, 401);
  });

  it('redirects battery tag links into the app', async () => {
    const res = await fetch(`${t.base}/b/B-12`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?scan=battery%3AB-12');
  });
});

describe('site PIN for worker devices (WORKER_PIN)', () => {
  let t;
  before(async () => {
    t = await startTestServer({ workerPin: '7788', managerPin: '9999' });
  });
  after(() => t.close());

  it('blocks reporting until the device enters the site PIN once', async () => {
    const cfg = await t.api('GET', '/api/config');
    assert.equal(cfg.data.devicePinRequired, true);
    const blocked = await t.api('POST', '/api/tickets', { unit: 'R-01', category: 'brakes', severity: 'down', reportedBy: 'Al' });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.data.code, 'device_pin');
    assert.equal((await t.api('GET', '/api/lifts')).status, 401);
    assert.equal((await t.api('POST', '/api/scan', { text: 'R-01' })).status, 401);

    assert.equal((await t.api('POST', '/api/device/login', { pin: '0000' })).status, 401);
    assert.equal((await t.api('POST', '/api/device/login', { pin: '7788' })).status, 200);
    assert.equal((await t.api('GET', '/api/device/session')).data.enrolled, true);
    const ok = await t.api('POST', '/api/tickets', { unit: 'R-01', category: 'brakes', severity: 'down', reportedBy: 'Al' });
    assert.equal(ok.status, 201);
    // The site PIN does not open the manager dashboard.
    assert.equal((await t.api('GET', '/api/manager/board')).status, 401);
  });

  it('lets a logged-in manager report from the same device', async () => {
    t.clearCookie();
    await t.api('POST', '/api/manager/login', { pin: '9999' });
    assert.equal((await t.api('GET', '/api/lifts')).status, 200);
  });
});
