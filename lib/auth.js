const crypto = require('node:crypto');
const { q } = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || (PROD ? null : 'dev-only-insecure-secret');
if (!SECRET) throw new Error('SESSION_SECRET must be set in production (any long random string).');

const COOKIE = 'bp_session';
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function issue(res, userId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const body = `${userId}.${exp}`;
  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: MAX_AGE_S * 1000, path: '/',
  });
}
const clear = (res) => res.clearCookie(COOKIE, { path: '/' });

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function currentUser(req) {
  const tok = readCookie(req);
  if (!tok) return null;
  const [uid, exp, mac] = tok.split('.');
  if (!uid || !exp || !mac || !safeEqual(mac, sign(`${uid}.${exp}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return q.get('select id, role, name, email, phone, instagram, shop_id, onboarded from users where id = $1', [Number(uid)]);
}

// Creates Ethan's admin login from ADMIN_EMAIL / ADMIN_PASSWORD the first time the app boots.
let adminReady;
function ensureAdmin() {
  adminReady ||= (async () => {
    const email = process.env.ADMIN_EMAIL, pw = process.env.ADMIN_PASSWORD;
    if (!email || !pw) return;
    const exists = await q.get('select id from users where lower(email) = lower($1)', [email]);
    if (exists) {
      await q.run("update users set role = 'admin', onboarded = true where id = $1", [exists.id]);
      return;
    }
    await q.run("insert into users (role, name, email, password_hash, onboarded) values ('admin', $1, $2, $3, true)",
      [process.env.ADMIN_NAME || 'Ethan', email.toLowerCase(), hashPassword(pw)]);
    console.log(`Admin account created for ${email}`);
  })().catch((e) => { adminReady = null; throw e; });
  return adminReady;
}

async function attachUser(req, _res, next) {
  try { await ensureAdmin(); req.user = await currentUser(req); next(); } catch (e) { next(e); }
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

module.exports = { hashPassword, verifyPassword, issue, clear, sign, safeEqual, attachUser, requireUser, requireAdmin };
