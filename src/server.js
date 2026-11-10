import { createApp } from './app.js';
import { deliveryStatus, loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Notifier } from './notify/notifier.js';
import { createSenders } from './notify/senders.js';
import { seedIfEmpty } from './seed.js';
import { Store } from './store.js';

const config = loadConfig();
const db = openDatabase(config.dbFile);
const store = new Store(db);
if (seedIfEmpty(store, { demoLifts: config.seedDemo })) {
  console.log('First run: created starter contacts and alert rules' + (config.seedDemo ? ' and demo lifts.' : '.'));
}

const senders = createSenders(config);
const notifier = new Notifier({ store, senders });
const app = createApp({ store, notifier, config });

const server = app.listen(config.port, () => {
  console.log(`Forklift Down running on http://localhost:${config.port}`);
  console.log(`  Worker app:  ${config.publicUrl || `http://localhost:${config.port}`}/`);
  console.log(`  Manager:     ${config.publicUrl || `http://localhost:${config.port}`}/manager`);
  const delivery = deliveryStatus(config);
  console.log(`  Data:  ${config.dbFile}`);
  console.log(`  Email: ${delivery.email ?? 'not configured (alerts logged only)'}`);
  console.log(`  SMS:   ${senders.sms ? 'Twilio ' + config.twilio.from : 'not configured (alerts logged only)'}`);
  if (config.onRailway && !config.hasPersistentVolume) {
    console.warn('  ⚠ No Railway Volume attached — the database is wiped on every deploy! Add a Volume (mount path /data).');
  }
  if (config.onRailway && !delivery.email) {
    console.warn('  ⚠ No email provider set. Railway blocks SMTP below the Pro plan — set RESEND_API_KEY.');
  }
  if (config.onRailway && !config.workerPin) {
    console.warn('  ⚠ WORKER_PIN is not set — anyone who finds the public URL can submit reports.');
  }
  if (!config.managerPin) console.warn('  ⚠ MANAGER_PIN is not set — the manager dashboard is open to anyone.');
  if (!config.publicUrl) console.warn('  ⚠ PUBLIC_URL is not set — alerts will not include ticket links.');
  if (!process.env.SESSION_SECRET) {
    console.warn('  ⚠ SESSION_SECRET is not set — logins and alert links stop working after a restart.');
  }
});

// Escalate DOWN tickets that nobody has acknowledged in time.
const escalationTimer = setInterval(() => {
  try {
    const ids = app.locals.service.runEscalation();
    if (ids.length) console.log(`Escalated ticket(s): ${ids.join(', ')}`);
  } catch (err) {
    console.error('Escalation check failed', err);
  }
}, config.escalationIntervalMs);

function shutdown() {
  clearInterval(escalationTimer);
  server.close(async () => {
    await notifier.flush();
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
