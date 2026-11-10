import crypto from 'node:crypto';
import path from 'node:path';

// All runtime configuration comes from environment variables (see .env.example).
// `overrides` lets tests build a config without touching process.env.
//
// Railway: when a Volume is attached Railway sets RAILWAY_VOLUME_MOUNT_PATH,
// and a generated domain sets RAILWAY_PUBLIC_DOMAIN — both are picked up
// automatically so the only required variables are MANAGER_PIN and
// SESSION_SECRET.
export function loadConfig(overrides = {}, env = process.env) {
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  const dataDir = path.resolve(overrides.dataDir || env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data');
  const publicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  const config = {
    port: Number(env.PORT || 3000),
    onRailway,
    hasPersistentVolume: !!(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH),
    dataDir,
    dbFile: overrides.dbFile || env.DB_FILE || path.join(dataDir, 'forklift.db'),
    uploadsDir: overrides.uploadsDir ?? path.join(dataDir, 'uploads'),
    // Base URL used in alert links and QR codes, e.g. https://lifts.example.com
    publicUrl: publicUrl.replace(/\/+$/, ''),
    managerPin: env.MANAGER_PIN ?? '',
    // Optional site PIN each worker device enters once (recommended when the
    // app is on the public internet, e.g. Railway). Empty = no PIN.
    workerPin: env.WORKER_PIN ?? '',
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    seedDemo: (env.SEED_DEMO || 'true') !== 'false',
    // Behind a reverse proxy (Railway, Render, nginx…) so secure cookies,
    // https QR links and client IPs work. Railway's edge is one hop.
    trustProxy: parseTrustProxy(env.TRUST_PROXY || (onRailway ? '1' : '')),
    emailFrom: env.EMAIL_FROM || env.SMTP_FROM || 'Forklift Alerts <alerts@example.com>',
    // Resend sends over HTTPS, so it works on every Railway plan
    // (Railway blocks outbound SMTP below the Pro plan).
    resend: {
      apiKey: env.RESEND_API_KEY ?? '',
    },
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER ?? '',
      pass: env.SMTP_PASS ?? '',
    },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID ?? '',
      authToken: env.TWILIO_AUTH_TOKEN ?? '',
      from: env.TWILIO_FROM ?? '',
    },
    escalationIntervalMs: Number(env.ESCALATION_CHECK_MS || 60_000),
    ...overrides,
  };
  return config;
}

// Express wants a hop count as a number, true/false, or a list of addresses.
function parseTrustProxy(value) {
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

// What the manager dashboard shows under "Server alert delivery".
export function deliveryStatus(config) {
  return {
    email: config.resend.apiKey ? 'Resend' : config.smtp.host ? `SMTP ${config.smtp.host}` : null,
    sms: !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.from),
    publicUrl: config.publicUrl || null,
  };
}
