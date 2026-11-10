import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Notifier } from '../src/notify/notifier.js';
import { seedIfEmpty } from '../src/seed.js';
import { Store } from '../src/store.js';

// Boots the full app on a random port with an in-memory database and fake
// SMS/email/webhook senders that record what they would have sent.
export async function startTestServer({ managerPin = '', workerPin = '', publicUrl = 'https://lifts.test', seed = true, senders } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forklift-test-'));
  const config = loadConfig({ dataDir, dbFile: ':memory:' }, { MANAGER_PIN: managerPin, WORKER_PIN: workerPin, PUBLIC_URL: publicUrl });
  const db = openDatabase(':memory:');
  const store = new Store(db);
  if (seed) seedIfEmpty(store, { demoLifts: true });

  const sent = [];
  const fake = (channel) => async (msg) => {
    sent.push({ channel, ...msg });
  };
  const notifier = new Notifier({
    store,
    senders: senders ?? { email: fake('email'), sms: fake('sms'), webhook: fake('webhook') },
    logger: { info() {}, error() {} },
  });
  const app = createApp({ store, notifier, config });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function api(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  // Give every starter contact an address so alerts actually "send".
  function giveContactsAddresses() {
    for (const c of store.listContacts()) {
      const slug = c.name.toLowerCase().replace(/[^a-z]+/g, '.');
      store.updateContact(c.id, {
        ...c,
        email: `${slug}@example.com`,
        phone: `+1555000${String(c.id).padStart(4, '0')}`,
        webhookUrl: `https://hooks.slack.com/services/T/${c.id}`,
      });
    }
  }

  async function close() {
    await notifier.flush();
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { base, api, store, notifier, config, sent, app, giveContactsAddresses, close, clearCookie: () => (cookie = '') };
}
