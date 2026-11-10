import crypto from 'node:crypto';

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Ticket links in alerts carry a token so a tech can open and update that one
// ticket from their phone with a single tap, without logging in.
export function ticketToken(secret, ticketId) {
  return hmac(secret, `ticket:${ticketId}`).slice(0, 22);
}

export function verifyTicketToken(secret, ticketId, token) {
  return !!token && safeEqual(ticketToken(secret, ticketId), token);
}

export function ticketLink(config, ticketId) {
  if (!config.publicUrl) return null;
  return `${config.publicUrl}/t/${ticketId}?k=${ticketToken(config.sessionSecret, ticketId)}`;
}

const COOKIE = 'fd_mgr';
const SESSION_DAYS = 30;
const DEVICE_COOKIE = 'fd_dev';
const DEVICE_DAYS = 365;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth(config) {
  const secret = config.sessionSecret;
  const protectedMode = !!config.managerPin;
  const devicePinRequired = !!config.workerPin;
  const failures = new Map(); // ip -> { count, until }

  function validCookie(req, name, purpose) {
    const raw = parseCookies(req.headers.cookie)[name];
    if (!raw) return false;
    const [exp, sig] = raw.split('.');
    return !!exp && !!sig && safeEqual(hmac(secret, `${purpose}:${exp}`), sig) && Number(exp) > Date.now();
  }

  function setCookie(res, req, name, purpose, days) {
    const exp = Date.now() + days * 24 * 3600e3;
    const value = `${exp}.${hmac(secret, `${purpose}:${exp}`)}`;
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`);
  }

  function isManager(req) {
    return !protectedMode || validCookie(req, COOKIE, 'mgr');
  }

  // A worker device that has entered the site PIN (or a logged-in manager).
  function isDevice(req) {
    return !devicePinRequired || validCookie(req, DEVICE_COOKIE, 'dev') || (protectedMode && isManager(req));
  }

  function setSessionCookie(res, req) {
    setCookie(res, req, COOKIE, 'mgr', SESSION_DAYS);
  }

  function setDeviceCookie(res, req) {
    setCookie(res, req, DEVICE_COOKIE, 'dev', DEVICE_DAYS);
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // Returns { ok } or { ok: false, retryAfterSec }. Locks an IP out for 15
  // minutes after 10 bad PINs.
  function checkPin(req, pin, expected = config.managerPin) {
    const ip = req.ip ?? 'unknown';
    const entry = failures.get(ip);
    if (entry && entry.until > Date.now()) {
      return { ok: false, retryAfterSec: Math.ceil((entry.until - Date.now()) / 1000) };
    }
    if (safeEqual(String(pin ?? ''), expected)) {
      failures.delete(ip);
      return { ok: true };
    }
    const count = (entry?.count ?? 0) + 1;
    failures.set(ip, { count, until: count >= 10 ? Date.now() + 15 * 60e3 : 0 });
    return { ok: false };
  }

  function requireDevice(req, res, next) {
    if (isDevice(req)) return next();
    res.status(401).json({ error: 'Enter the site PIN on this device first', code: 'device_pin' });
  }

  function requireManager(req, res, next) {
    if (isManager(req)) return next();
    res.status(401).json({ error: 'Manager login required' });
  }

  // Manager session OR the signed token from an alert link.
  function requireTicketAccess(req, res, next) {
    const token = req.query.k ?? req.get('x-ticket-token');
    if (isManager(req) || verifyTicketToken(secret, req.params.id, token)) return next();
    res.status(401).json({ error: 'This link is not valid for this ticket' });
  }

  return {
    protectedMode,
    devicePinRequired,
    isManager,
    isDevice,
    setDeviceCookie,
    requireDevice,
    setSessionCookie,
    clearSessionCookie,
    checkPin,
    requireManager,
    requireTicketAccess,
  };
}
