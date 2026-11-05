const path = require('node:path');
const express = require('express');
const { q } = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const stripe = require('./stripe');
const { PACKAGES, ADDONS, getPackage, getAddon } = require('./packages');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const DEMO_PAYMENTS = process.env.DEMO_PAYMENTS === '1' && process.env.NODE_ENV !== 'production';
const RUSH_DAYS = 2, STANDARD_DAYS = 7; // editing turnaround used for "photos due" dates

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isoOrNull = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); };
const originOf = (req) => SITE_URL || `${req.protocol}://${req.get('host')}`;

// ---------- Stripe webhook needs the raw body, so it goes before express.json ----------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), wrap(async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).end();
  const event = stripe.verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'), secret);
  if (!event) return res.status(400).send('bad signature');
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await recordStripePayment(event.data.object);
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '1mb' }));

// Setup check: which settings are present (never their values) and whether the database answers.
app.get('/api/health', wrap(async (_req, res) => {
  const env = Object.fromEntries(['DATABASE_URL', 'SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SITE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
    .map((k) => [k, Boolean(process.env[k])]));
  const out = { env, database: 'unknown', tables: 'unknown', admin: 'unknown' };
  try {
    await q.get('select 1');
    out.database = 'connected';
    const t = await q.all("select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)",
      [['shops', 'users', 'shoots', 'payments', 'photos']]);
    out.tables = t.length === 5 ? 'ok' : `missing: run supabase/schema.sql in the Supabase SQL Editor (found ${t.length}/5)`;
    if (t.length === 5) {
      await auth.ensureAdmin();
      out.admin = (await q.get("select count(*)::int n from users where role = 'admin'")).n ? 'exists' : 'not created: set ADMIN_EMAIL and ADMIN_PASSWORD, then redeploy';
    }
  } catch (e) {
    out.database = `error: ${e.message}`;
  }
  res.json(out);
}));

app.use(auth.attachUser);
storage.devRoutes(app, express);

// ---------- shared helpers ----------
const SHOOT_SELECT = `
  select s.*, u.name as barber_name, u.email as barber_email, u.phone as barber_phone, u.instagram as barber_instagram,
         sh.name as shop_name, sh.address as shop_address, sh.lat as shop_lat, sh.lng as shop_lng,
         coalesce((select sum(p.amount_cents) from payments p where p.shoot_id = s.id), 0)::int as paid_cents,
         (select count(*) from photos ph where ph.shoot_id = s.id)::int as photo_count
  from shoots s
  join users u on u.id = s.barber_id
  left join shops sh on sh.id = s.shop_id`;

function decorate(s) {
  const balance = Math.max(s.price_cents - s.paid_cents, 0);
  const rush = (s.addons || []).some((a) => a.key === 'rush');
  let due_at = null;
  if (s.status === 'completed' && s.completed_at) {
    due_at = new Date(new Date(s.completed_at).getTime() + (rush ? RUSH_DAYS : STANDARD_DAYS) * 86_400_000).toISOString();
  }
  return { ...s, balance_cents: balance, unlocked: balance === 0, rush, due_at };
}

async function recordStripePayment(session) {
  const shootId = Number(session?.metadata?.shoot_id);
  if (!shootId || session.payment_status !== 'paid') return false;
  await q.run(
    `insert into payments (shoot_id, amount_cents, method, reference, note)
     values ($1, $2, 'stripe', $3, 'Paid online') on conflict (reference) do nothing`,
    [shootId, session.amount_total, session.id]);
  return true;
}

async function upsertShop(shop) {
  const name = str(shop?.name, 120);
  if (!name) return null;
  const address = str(shop.address, 300) || null;
  const placeId = str(shop.place_id, 200) || null;
  const lat = num(shop.lat), lng = num(shop.lng);
  const source = ['google', 'osm', 'manual', 'existing'].includes(shop.source) ? shop.source : 'manual';
  if (num(shop.id)) {
    const s = await q.get('select id from shops where id = $1', [num(shop.id)]);
    if (s) return s.id;
  }
  if (placeId) {
    const s = await q.get('select id from shops where place_id = $1', [placeId]);
    if (s) return s.id;
  }
  const dupe = await q.get(
    "select id from shops where lower(name) = lower($1) and lower(coalesce(address,'')) = lower(coalesce($2,''))", [name, address]);
  if (dupe) return dupe.id;
  const row = await q.get(
    'insert into shops (name, address, lat, lng, place_id, source) values ($1,$2,$3,$4,$5,$6) returning id',
    [name, address, lat, lng, placeId, source]);
  return row.id;
}

function priceFor(packageKey, addonKeys) {
  const pkg = getPackage(packageKey);
  if (!pkg) return null;
  const addons = (Array.isArray(addonKeys) ? addonKeys : []).map(getAddon).filter(Boolean)
    .filter((a, i, arr) => arr.findIndex((b) => b.key === a.key) === i);
  return { pkg, addons, total: pkg.price + addons.reduce((t, a) => t + a.price, 0) };
}

// ---------- public ----------
app.get('/api/config', (req, res) => res.json({
  packages: PACKAGES, addons: ADDONS,
  payments: stripe.enabled ? 'stripe' : DEMO_PAYMENTS ? 'demo' : 'offline',
  googleMaps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
  instagram: 'https://www.instagram.com/barberpulse.to/',
}));

// ---------- auth ----------
app.post('/api/auth/signup', wrap(async (req, res) => {
  const name = str(req.body.name, 100), email = str(req.body.email, 200).toLowerCase();
  const phone = str(req.body.phone, 30), password = String(req.body.password || '');
  if (!name) return bad(res, 'Enter your name.');
  if (!emailOk(email)) return bad(res, 'Enter a valid email.');
  if (phone.replace(/\D/g, '').length < 10) return bad(res, 'Enter a valid phone number.');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (await q.get('select id from users where lower(email) = $1', [email])) return bad(res, 'That email already has an account. Log in instead.', 409);
  const u = await q.get(
    'insert into users (name, email, phone, password_hash) values ($1,$2,$3,$4) returning id',
    [name, email, phone, auth.hashPassword(password)]);
  auth.issue(res, u.id);
  res.json({ ok: true, next: '/signup?step=shop' });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const u = await q.get('select id, role, onboarded, password_hash from users where lower(email) = $1', [email]);
  if (!u || !auth.verifyPassword(String(req.body.password || ''), u.password_hash)) return bad(res, 'Wrong email or password.', 401);
  auth.issue(res, u.id);
  res.json({ ok: true, next: u.role === 'admin' ? '/admin' : u.onboarded ? '/portal' : '/signup?step=shop' });
}));

app.post('/api/auth/logout', (req, res) => { auth.clear(res); res.json({ ok: true }); });

app.get('/api/me', wrap(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const shop = req.user.shop_id ? await q.get('select * from shops where id = $1', [req.user.shop_id]) : null;
  res.json({ user: { ...req.user, shop } });
}));

// ---------- shop lookup (geolocation → nearby barbershops) ----------
app.get('/api/shops/nearby', auth.requireUser, wrap(async (req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng);
  if (lat === null || lng === null) return bad(res, 'lat/lng required');
  const results = [];
  // 1) shops already in Barber Pulse within ~3 km
  const known = await q.all(
    `select id, name, address, lat, lng from shops where lat is not null and lng is not null
     and abs(lat - $1) < 0.03 and abs(lng - $2) < 0.04 limit 15`, [lat, lng]);
  known.forEach((s) => results.push({ ...s, source: 'existing' }));
  // 2) Google Places (if key) else OpenStreetMap
  try {
    const found = process.env.GOOGLE_MAPS_API_KEY ? await googleNearby(lat, lng) : await osmNearby(lat, lng);
    for (const f of found) {
      if (!results.some((r) => r.name.toLowerCase() === f.name.toLowerCase())) results.push(f);
    }
  } catch (e) {
    console.warn('nearby lookup failed:', e.message);
  }
  const dist = (s) => Math.hypot(s.lat - lat, (s.lng - lng) * Math.cos((lat * Math.PI) / 180));
  results.sort((a, b) => dist(a) - dist(b));
  res.json({ shops: results.slice(0, 20) });
}));

app.get('/api/shops/search', auth.requireUser, wrap(async (req, res) => {
  const text = str(req.query.q, 200);
  if (text.length < 3) return res.json({ shops: [] });
  try {
    const found = process.env.GOOGLE_MAPS_API_KEY ? await googleText(text) : await osmText(text);
    res.json({ shops: found.slice(0, 8) });
  } catch (e) {
    console.warn('search failed:', e.message);
    res.json({ shops: [], warning: 'Search is unavailable right now. Enter the shop manually.' });
  }
}));

async function googleNearby(lat, lng) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({ includedTypes: ['barber_shop', 'hair_salon'], maxResultCount: 15,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 2500 } } }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Google Places error');
  return (j.places || []).map(fromGoogle);
}
async function googleText(text) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({ textQuery: text, locationBias: { circle: { center: { latitude: 43.6532, longitude: -79.3832 }, radius: 50000 } } }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Google Places error');
  return (j.places || []).map(fromGoogle);
}
const fromGoogle = (p) => ({
  name: p.displayName?.text, address: p.formattedAddress, lat: p.location?.latitude, lng: p.location?.longitude,
  place_id: `google:${p.id}`, source: 'google',
});

const OSM_UA = 'BarberPulse/1.0 (barberpulse.co)';
async function osmNearby(lat, lng) {
  const query = `[out:json][timeout:8];(nwr(around:2500,${lat},${lng})["shop"~"hairdresser|barber"];);out center 25;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': OSM_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(9000),
  });
  const j = await r.json();
  return (j.elements || []).filter((e) => e.tags?.name).map((e) => {
    const t = e.tags;
    const address = [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:city']].filter(Boolean).join(', ');
    return { name: t.name, address: address || null, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
      place_id: `osm:${e.type}/${e.id}`, source: 'osm' };
  });
}
async function osmText(text) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.search = new URLSearchParams({ q: text, format: 'jsonv2', limit: '8', countrycodes: 'ca', viewbox: '-80.2,44.2,-78.6,43.3', addressdetails: '0' });
  const r = await fetch(u, { headers: { 'User-Agent': OSM_UA }, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return j.map((p) => ({ name: p.name || p.display_name.split(',')[0], address: p.display_name, lat: Number(p.lat), lng: Number(p.lon),
    place_id: `osm:${p.osm_type}/${p.osm_id}`, source: 'osm' }));
}

// ---------- barber onboarding + portal ----------
app.post('/api/onboarding', auth.requireUser, wrap(async (req, res) => {
  const shopId = await upsertShop(req.body.shop);
  if (!shopId) return bad(res, 'Tell us where you cut — pick a shop or type its name and address.');
  const shop = await q.get('select address from shops where id = $1', [shopId]);
  if (!shop.address) await q.run('update shops set address = $1 where id = $2', [str(req.body.shop.address, 300) || null, shopId]);
  const ig = str(req.body.instagram, 60).replace(/^@/, '') || null;
  await q.run('update users set shop_id = $1, instagram = coalesce($2, instagram), onboarded = true where id = $3', [shopId, ig, req.user.id]);
  res.json({ ok: true, next: req.user.role === 'admin' ? '/admin' : '/portal' });
}));

app.patch('/api/me', auth.requireUser, wrap(async (req, res) => {
  const name = str(req.body.name, 100), phone = str(req.body.phone, 30), ig = str(req.body.instagram, 60).replace(/^@/, '');
  await q.run('update users set name = coalesce(nullif($1,\'\'), name), phone = coalesce(nullif($2,\'\'), phone), instagram = nullif($3,\'\') where id = $4',
    [name, phone, ig, req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/my/shoots', auth.requireUser, wrap(async (req, res) => {
  const rows = (await q.all(`${SHOOT_SELECT} where s.barber_id = $1 order by coalesce(s.scheduled_at, s.created_at) desc`, [req.user.id])).map(decorate);
  const ids = rows.map((r) => r.id);
  const photos = ids.length ? await q.all('select id, shoot_id, storage_path, is_preview from photos where shoot_id = any($1) order by id', [ids]) : [];
  const visible = [];
  const out = rows.map((s) => {
    const mine = photos.filter((p) => p.shoot_id === s.id);
    const flagged = mine.filter((p) => p.is_preview);
    const previews = s.unlocked ? mine : (flagged.length ? flagged : mine).slice(0, s.preview_count);
    visible.push(...previews.map((p) => p.storage_path));
    return {
      id: s.id, package_key: s.package_key, package_name: s.package_name, addons: s.addons, status: s.status,
      scheduled_at: s.scheduled_at, completed_at: s.completed_at, notes: s.notes, shop_name: s.shop_name, shop_address: s.shop_address,
      price_cents: s.price_cents, paid_cents: s.paid_cents, balance_cents: s.balance_cents, unlocked: s.unlocked,
      drive_link: s.unlocked ? s.drive_link : null, has_drive_link: Boolean(s.drive_link),
      photos: previews.map((p) => ({ id: p.id, path: p.storage_path })),
      locked_count: mine.length - previews.length,
    };
  });
  const urls = await storage.viewUrls(visible);
  out.forEach((s) => s.photos.forEach((p) => { p.url = urls[p.path]; delete p.path; }));
  res.json({ shoots: out });
}));

app.post('/api/my/bookings', auth.requireUser, wrap(async (req, res) => {
  const price = priceFor(req.body.package_key, req.body.addons);
  if (!price) return bad(res, 'Pick a package.');
  const when = isoOrNull(req.body.preferred_at);
  if (when === undefined) return bad(res, 'Pick a valid date and time.');
  if (when && new Date(when) < Date.now() - 3600_000) return bad(res, 'Pick a time in the future.');
  let shopId = req.user.shop_id;
  if (req.body.shop && str(req.body.shop.name)) shopId = await upsertShop(req.body.shop);
  const row = await q.get(
    `insert into shoots (barber_id, shop_id, package_key, package_name, addons, price_cents, status, scheduled_at, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,'requested',$7,$8,'barber') returning id`,
    [req.user.id, shopId, price.pkg.key, price.pkg.name, JSON.stringify(price.addons), price.total, when, str(req.body.notes, 1000) || null]);
  res.json({ ok: true, id: row.id });
}));

app.post('/api/my/shoots/:id/cancel', auth.requireUser, wrap(async (req, res) => {
  const r = await q.run("update shoots set status = 'cancelled' where id = $1 and barber_id = $2 and status = 'requested'", [num(req.params.id), req.user.id]);
  if (!r.rowCount) return bad(res, 'Only pending requests can be cancelled. Message us to change a confirmed shoot.');
  res.json({ ok: true });
}));

// ---------- payments ----------
app.post('/api/my/shoots/:id/checkout', auth.requireUser, wrap(async (req, res) => {
  const s = await q.get(`${SHOOT_SELECT} where s.id = $1 and s.barber_id = $2`, [num(req.params.id), req.user.id]);
  if (!s) return bad(res, 'Shoot not found.', 404);
  const shoot = decorate(s);
  if (shoot.status === 'cancelled') return bad(res, 'This shoot was cancelled.');
  if (shoot.balance_cents <= 0) return bad(res, 'Already paid — your photos are unlocked.');
  if (stripe.enabled) {
    const origin = originOf(req);
    const session = await stripe.createCheckout({
      amountCents: shoot.balance_cents, shootId: shoot.id, email: req.user.email,
      name: `Barber Pulse · ${shoot.package_name}`,
      description: shoot.package_key === 'walkin' ? 'Unlock your full photo set' : `Shoot #${shoot.id}`,
      successUrl: `${origin}/portal?paid={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/portal?cancelled=1`,
    });
    return res.json({ url: session.url });
  }
  if (DEMO_PAYMENTS) {
    await q.run("insert into payments (shoot_id, amount_cents, method, note) values ($1,$2,'demo','Demo payment (no Stripe key)')", [shoot.id, shoot.balance_cents]);
    return res.json({ ok: true, demo: true });
  }
  bad(res, 'Online payments are not switched on yet. Pay Ethan directly (cash / e-Transfer) and he will unlock your photos.', 503);
}));

// Called when Stripe redirects back, so the unlock is instant even before the webhook lands.
app.post('/api/stripe/confirm', auth.requireUser, wrap(async (req, res) => {
  if (!stripe.enabled) return bad(res, 'Stripe not configured', 503);
  const session = await stripe.getCheckout(str(req.body.session_id, 200));
  const shoot = await q.get('select barber_id from shoots where id = $1', [Number(session.metadata?.shoot_id)]);
  if (!shoot || shoot.barber_id !== req.user.id) return bad(res, 'Not your payment.', 403);
  res.json({ ok: await recordStripePayment(session) });
}));

// ---------- admin ----------
const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/overview', wrap(async (req, res) => {
  const start = isoOrNull(req.query.start), end = isoOrNull(req.query.end);
  if (!start || !end) return bad(res, 'start and end required');
  const [k] = await q.all(`
    select
      (select coalesce(sum(amount_cents),0) from payments)::int as revenue_all,
      (select coalesce(sum(amount_cents),0) from payments where paid_at >= $1 and paid_at < $2)::int as revenue_period,
      (select count(*) from payments where paid_at >= $1 and paid_at < $2)::int as payments_period,
      (select count(*) from shoots where status = 'requested')::int as requests,
      (select count(*) from shoots where status = 'scheduled' and scheduled_at >= now() and scheduled_at < now() + interval '7 days')::int as upcoming_7d,
      (select count(*) from shoots where status = 'completed')::int as editing,
      (select count(*) from shoots where scheduled_at >= $1 and scheduled_at < $2 and status <> 'cancelled')::int as shoots_period,
      (select count(*) from users where role = 'barber')::int as barbers,
      (select count(*) from users where role = 'barber' and created_at >= $1 and created_at < $2)::int as new_barbers_period,
      (select count(distinct shop_id) from shoots where status in ('completed','delivered') and shop_id is not null)::int as shops_visited`,
  [start, end]);
  const outstanding = await q.get(`
    select coalesce(sum(greatest(s.price_cents - coalesce(p.paid,0), 0)),0)::int as cents, count(*) filter (where s.price_cents > coalesce(p.paid,0))::int as n
    from shoots s left join (select shoot_id, sum(amount_cents) paid from payments group by shoot_id) p on p.shoot_id = s.id
    where s.status in ('completed','delivered')`);
  const payments = await q.all(`
    select p.id, p.amount_cents, p.method, p.paid_at, p.note, s.id as shoot_id, s.package_name, u.name as barber_name
    from payments p join shoots s on s.id = p.shoot_id join users u on u.id = s.barber_id
    where p.paid_at >= $1 and p.paid_at < $2 order by p.paid_at`, [start, end]);
  const shoots = (await q.all(`${SHOOT_SELECT} where s.scheduled_at >= $1 and s.scheduled_at < $2 and s.status <> 'cancelled' order by s.scheduled_at`, [start, end])).map(decorate);
  const due = (await q.all(`${SHOOT_SELECT} where s.status = 'completed' order by s.completed_at`)).map(decorate);
  res.json({ kpis: { ...k, outstanding_cents: outstanding.cents, outstanding_count: outstanding.n }, payments, shoots, due });
}));

admin.get('/shoots', wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.status) { params.push(str(req.query.status)); where.push(`s.status = $${params.length}`); }
  if (req.query.barber_id) { params.push(num(req.query.barber_id)); where.push(`s.barber_id = $${params.length}`); }
  if (req.query.unpaid === '1') where.push('s.price_cents > coalesce((select sum(p.amount_cents) from payments p where p.shoot_id = s.id),0)');
  const rows = await q.all(`${SHOOT_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''}
    order by case s.status when 'requested' then 0 when 'scheduled' then 1 when 'completed' then 2 else 3 end,
             s.scheduled_at asc nulls last, s.id desc limit 500`, params);
  res.json({ shoots: rows.map(decorate) });
}));

admin.get('/shoots/:id', wrap(async (req, res) => {
  const s = await q.get(`${SHOOT_SELECT} where s.id = $1`, [num(req.params.id)]);
  if (!s) return bad(res, 'Not found', 404);
  const photos = await q.all('select id, storage_path, original_name, is_preview from photos where shoot_id = $1 order by id', [s.id]);
  const urls = await storage.viewUrls(photos.map((p) => p.storage_path));
  const payments = await q.all('select * from payments where shoot_id = $1 order by paid_at', [s.id]);
  res.json({ shoot: decorate(s), photos: photos.map((p) => ({ ...p, url: urls[p.storage_path] })), payments });
}));

admin.post('/shoots', wrap(async (req, res) => {
  const barber = await q.get("select id, shop_id from users where id = $1", [num(req.body.barber_id)]);
  if (!barber) return bad(res, 'Pick a barber.');
  const price = priceFor(req.body.package_key, req.body.addons);
  if (!price) return bad(res, 'Pick a package.');
  const when = isoOrNull(req.body.scheduled_at);
  if (when === undefined) return bad(res, 'Invalid date.');
  const status = ['requested', 'scheduled', 'completed', 'delivered'].includes(req.body.status) ? req.body.status : (when ? 'scheduled' : 'requested');
  const priceCents = num(req.body.price_cents) ?? price.total;
  const row = await q.get(
    `insert into shoots (barber_id, shop_id, package_key, package_name, addons, price_cents, status, scheduled_at, completed_at, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin') returning id`,
    [barber.id, num(req.body.shop_id) || barber.shop_id, price.pkg.key, price.pkg.name, JSON.stringify(price.addons), Math.max(0, Math.round(priceCents)),
      status, when || (status === 'completed' || status === 'delivered' ? new Date().toISOString() : null),
      status === 'completed' || status === 'delivered' ? new Date().toISOString() : null, str(req.body.notes, 1000) || null]);
  res.json({ ok: true, id: row.id });
}));

admin.patch('/shoots/:id', wrap(async (req, res) => {
  const id = num(req.params.id);
  const cur = await q.get('select * from shoots where id = $1', [id]);
  if (!cur) return bad(res, 'Not found', 404);
  const b = req.body, sets = [], params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.status !== undefined) {
    if (!['requested', 'scheduled', 'completed', 'delivered', 'cancelled'].includes(b.status)) return bad(res, 'Bad status');
    set('status', b.status);
    if (['completed', 'delivered'].includes(b.status) && !cur.completed_at) set('completed_at', new Date().toISOString());
  }
  if (b.scheduled_at !== undefined) { const w = isoOrNull(b.scheduled_at); if (w === undefined) return bad(res, 'Invalid date'); set('scheduled_at', w); }
  if (b.drive_link !== undefined) {
    const link = str(b.drive_link, 1000);
    if (link && !/^https:\/\//i.test(link)) return bad(res, 'Drive link must start with https://');
    set('drive_link', link || null);
  }
  if (b.price_cents !== undefined) { const p = num(b.price_cents); if (p === null || p < 0) return bad(res, 'Bad price'); set('price_cents', Math.round(p)); }
  if (b.preview_count !== undefined) set('preview_count', Math.max(0, Math.min(20, num(b.preview_count) ?? 3)));
  if (b.admin_notes !== undefined) set('admin_notes', str(b.admin_notes, 2000) || null);
  if (b.shop_id !== undefined) set('shop_id', num(b.shop_id));
  if (!sets.length) return res.json({ ok: true });
  params.push(id);
  await q.run(`update shoots set ${sets.join(', ')} where id = $${params.length}`, params);
  res.json({ ok: true });
}));

admin.delete('/shoots/:id', wrap(async (req, res) => {
  const photos = await q.all('select storage_path from photos where shoot_id = $1', [num(req.params.id)]);
  await storage.remove(photos.map((p) => p.storage_path));
  await q.run('delete from shoots where id = $1', [num(req.params.id)]);
  res.json({ ok: true });
}));

admin.post('/shoots/:id/payments', wrap(async (req, res) => {
  const id = num(req.params.id);
  const amount = Math.round(num(req.body.amount_cents) ?? 0);
  if (!amount) return bad(res, 'Enter an amount.');
  const method = ['cash', 'etransfer', 'stripe', 'square', 'other'].includes(req.body.method) ? req.body.method : 'other';
  const paidAt = isoOrNull(req.body.paid_at) || new Date().toISOString();
  if (!(await q.get('select id from shoots where id = $1', [id]))) return bad(res, 'Not found', 404);
  await q.run('insert into payments (shoot_id, amount_cents, method, note, paid_at) values ($1,$2,$3,$4,$5)',
    [id, amount, method, str(req.body.note, 300) || null, paidAt]);
  res.json({ ok: true });
}));

admin.delete('/payments/:id', wrap(async (req, res) => {
  await q.run('delete from payments where id = $1', [num(req.params.id)]);
  res.json({ ok: true });
}));

// Photos: get signed upload URLs → browser uploads directly → confirm.
admin.post('/shoots/:id/photos/sign', wrap(async (req, res) => {
  const id = num(req.params.id);
  if (!(await q.get('select id from shoots where id = $1', [id]))) return bad(res, 'Not found', 404);
  const files = (Array.isArray(req.body.files) ? req.body.files : []).slice(0, 50);
  const uploads = [];
  for (const f of files) {
    const p = `shoot-${id}/${storage.safeName(f.name)}`;
    uploads.push({ name: str(f.name, 200), path: p, url: await storage.createUploadUrl(p) });
  }
  res.json({ uploads });
}));

admin.post('/shoots/:id/photos', wrap(async (req, res) => {
  const id = num(req.params.id);
  const items = (Array.isArray(req.body.photos) ? req.body.photos : []).filter((p) => typeof p.path === 'string' && p.path.startsWith(`shoot-${id}/`));
  const existing = await q.get('select count(*)::int as n from photos where shoot_id = $1', [id]);
  await q.tx(async (t) => {
    for (const p of items) await t.run('insert into photos (shoot_id, storage_path, original_name) values ($1,$2,$3)', [id, p.path, str(p.name, 200) || null]);
  });
  res.json({ ok: true, added: items.length, total: existing.n + items.length });
}));

admin.patch('/photos/:id', wrap(async (req, res) => {
  await q.run('update photos set is_preview = $1 where id = $2', [Boolean(req.body.is_preview), num(req.params.id)]);
  res.json({ ok: true });
}));

admin.delete('/photos/:id', wrap(async (req, res) => {
  const p = await q.get('delete from photos where id = $1 returning storage_path', [num(req.params.id)]);
  if (p) await storage.remove([p.storage_path]);
  res.json({ ok: true });
}));

admin.get('/barbers', wrap(async (_req, res) => {
  const rows = await q.all(`
    select u.id, u.name, u.email, u.phone, u.instagram, u.created_at, u.onboarded,
           sh.id as shop_id, sh.name as shop_name, sh.address as shop_address,
           count(s.id) filter (where s.status <> 'cancelled')::int as shoots,
           max(s.scheduled_at) filter (where s.status <> 'cancelled') as last_shoot,
           coalesce(sum(s.price_cents) filter (where s.status <> 'cancelled'),0)::int as billed_cents,
           coalesce((select sum(p.amount_cents) from payments p join shoots s2 on s2.id = p.shoot_id where s2.barber_id = u.id),0)::int as paid_cents
    from users u left join shops sh on sh.id = u.shop_id left join shoots s on s.barber_id = u.id
    where u.role = 'barber' group by u.id, sh.id order by u.created_at desc`);
  res.json({ barbers: rows.map((r) => ({ ...r, owing_cents: Math.max(r.billed_cents - r.paid_cents, 0) })) });
}));

admin.post('/barbers', wrap(async (req, res) => {
  // Quick-add for a walk-in barber who hasn't signed up yet. They can claim it later via "forgot password" → Ethan resets.
  const name = str(req.body.name, 100), email = str(req.body.email, 200).toLowerCase(), phone = str(req.body.phone, 30);
  if (!name || !emailOk(email)) return bad(res, 'Name and a valid email are required.');
  if (await q.get('select id from users where lower(email) = $1', [email])) return bad(res, 'Email already exists.', 409);
  const shopId = req.body.shop ? await upsertShop(req.body.shop) : null;
  const tempPw = Math.random().toString(36).slice(2, 10);
  const u = await q.get('insert into users (name, email, phone, password_hash, shop_id, onboarded) values ($1,$2,$3,$4,$5,$6) returning id',
    [name, email, phone || null, auth.hashPassword(tempPw), shopId, Boolean(shopId)]);
  res.json({ ok: true, id: u.id, temp_password: tempPw });
}));

admin.post('/barbers/:id/reset-password', wrap(async (req, res) => {
  const tempPw = Math.random().toString(36).slice(2, 10);
  const r = await q.run("update users set password_hash = $1 where id = $2 and role = 'barber'", [auth.hashPassword(tempPw), num(req.params.id)]);
  if (!r.rowCount) return bad(res, 'Not found', 404);
  res.json({ ok: true, temp_password: tempPw });
}));

admin.get('/shops', wrap(async (_req, res) => {
  const rows = await q.all(`
    select sh.*,
      (select count(*) from users u where u.shop_id = sh.id and u.role = 'barber')::int as barbers,
      (select count(*) from shoots s where s.shop_id = sh.id and s.status in ('completed','delivered'))::int as visits,
      (select max(coalesce(s.completed_at, s.scheduled_at)) from shoots s where s.shop_id = sh.id and s.status in ('completed','delivered')) as last_visit,
      (select min(s.scheduled_at) from shoots s where s.shop_id = sh.id and s.status = 'scheduled' and s.scheduled_at >= now()) as next_visit,
      (select coalesce(sum(p.amount_cents),0) from payments p join shoots s on s.id = p.shoot_id where s.shop_id = sh.id)::int as revenue_cents
    from shops sh order by last_visit desc nulls last, sh.name`);
  res.json({ shops: rows });
}));

app.use('/api/admin', admin);
app.use('/api', (_req, res) => bad(res, 'Not found', 404));

// ---------- pages (Vercel serves /public itself; this covers local dev) ----------
const PUB = path.join(__dirname, '..', 'public');
app.use(express.static(PUB, { extensions: ['html'] }));
app.use((_req, res) => res.status(404).sendFile(path.join(PUB, '404.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  const setup = /relation .* does not exist|password authentication|ENOTFOUND|ECONNREFUSED|Tenant or user not found|self.signed/i.test(err.message || '');
  res.status(500).json({ error: setup ? 'Server setup problem: the database is not reachable or not set up. Open /api/health for details.' : 'Something went wrong. Try again.' });
});

module.exports = app;
