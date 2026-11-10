import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { deliveryStatus, loadConfig } from '../src/config.js';
import { createResendSender, createSmsSender, webhookPayload } from '../src/notify/senders.js';

describe('config', () => {
  it('picks up Railway volume, domain and proxy automatically', () => {
    const c = loadConfig(
      {},
      {
        RAILWAY_PROJECT_ID: 'p1',
        RAILWAY_VOLUME_MOUNT_PATH: '/data',
        RAILWAY_PUBLIC_DOMAIN: 'forklift-down.up.railway.app',
        PORT: '8080',
      },
    );
    assert.equal(c.onRailway, true);
    assert.equal(c.dataDir, '/data');
    assert.equal(c.dbFile, '/data/forklift.db');
    assert.equal(c.publicUrl, 'https://forklift-down.up.railway.app');
    assert.equal(c.trustProxy, 1);
    assert.equal(c.port, 8080);
    assert.equal(c.hasPersistentVolume, true);
  });

  it('treats blank variables (copied from .env.example) as unset', () => {
    const c = loadConfig({}, { DATA_DIR: '', PORT: '', TRUST_PROXY: '', PUBLIC_URL: 'https://x.test/' });
    assert.equal(c.dataDir, path.resolve('./data'));
    assert.equal(c.port, 3000);
    assert.equal(c.trustProxy, false);
    assert.equal(c.publicUrl, 'https://x.test');
    assert.equal(c.hasPersistentVolume, false);
  });

  it('prefers Resend over SMTP and reports what is configured', () => {
    const c = loadConfig({}, { RESEND_API_KEY: 're_123', SMTP_HOST: 'smtp.x', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550001111' });
    assert.deepEqual(deliveryStatus(c), { email: 'Resend', sms: true, publicUrl: null });
    assert.deepEqual(deliveryStatus(loadConfig({}, {})), { email: null, sms: false, publicUrl: null });
  });
});

describe('senders', () => {
  const okFetch = (calls) => async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  };

  it('sends email through the Resend API', async () => {
    const calls = [];
    const send = createResendSender('re_key', 'Alerts <a@x.com>', okFetch(calls));
    await send({ to: 'm@x.com', subject: 'S', text: 'T', html: '<p>T</p>' });
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_key');
    assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Alerts <a@x.com>', to: ['m@x.com'], subject: 'S', text: 'T', html: '<p>T</p>' });
  });

  it('sends SMS through Twilio and surfaces API errors', async () => {
    const calls = [];
    const send = createSmsSender({ accountSid: 'AC1', authToken: 'tok', from: '+15550001111' }, okFetch(calls));
    await send({ to: '+15552223333', sms: 'LIFT DOWN' });
    assert.match(calls[0].url, /Accounts\/AC1\/Messages\.json$/);
    const form = new URLSearchParams(calls[0].init.body.toString());
    assert.equal(form.get('To'), '+15552223333');
    assert.equal(form.get('Body'), 'LIFT DOWN');

    const failing = createSmsSender({ accountSid: 'AC1', authToken: 'tok', from: '+1' }, async () => new Response('bad number', { status: 400 }));
    await assert.rejects(failing({ to: '+1', sms: 'x' }), /Twilio responded 400/);
  });

  it('formats webhooks for Slack, Teams Workflows and generic receivers', () => {
    const msg = { subject: '[DOWN] R-01', text: 'line 1\nline 2', link: 'https://x/t/1?k=a' };
    assert.deepEqual(webhookPayload('https://hooks.slack.com/services/a/b/c', msg), { text: '*[DOWN] R-01*\nline 1\nline 2' });
    const teams = webhookPayload('https://prod-12.westus.logic.azure.com/workflows/abc', msg);
    assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(teams.attachments[0].content.actions[0].url, msg.link);
    const generic = webhookPayload('https://example.com/hook', msg);
    assert.equal(generic.subject, '[DOWN] R-01');
    assert.match(generic.text, /line 2/);
  });
});
