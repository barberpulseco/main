// Photo storage. Production: a PRIVATE Supabase Storage bucket. The browser uploads
// straight to Supabase with a one-time signed URL (Vercel functions cap request
// bodies at 4.5 MB), and photos are only ever served through short-lived signed URLs,
// so locked photos can't be fetched by guessing a link.
//
// Local dev without Supabase keys falls back to the ./.local-uploads folder.
const fs = require('node:fs');
const path = require('node:path');
const { sign, safeEqual } = require('./auth');

const BUCKET = process.env.SUPABASE_BUCKET || 'shoot-photos';
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const useSupabase = Boolean(SB_URL && SB_KEY);

let sb;
if (useSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
}

const LOCAL_DIR = path.join(__dirname, '..', '.local-uploads');
const URL_TTL_S = 60 * 60; // signed view links last 1 hour

function safeName(name) {
  const ext = (path.extname(name || '').toLowerCase().match(/^\.(jpe?g|png|webp|heic|gif)$/) || ['.jpg'])[0];
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

// Creates the private bucket the first time it's needed, so there's no manual setup step.
let bucketReady;
function ensureBucket() {
  bucketReady ||= sb.storage.createBucket(BUCKET, { public: false }).then(({ error }) => {
    if (error && !/exist/i.test(error.message)) { bucketReady = null; throw new Error(`Storage: ${error.message}`); }
  });
  return bucketReady;
}

async function createUploadUrl(objectPath) {
  if (useSupabase) {
    await ensureBucket();
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(objectPath);
    if (error) throw new Error(`Storage: ${error.message}`);
    return data.signedUrl;
  }
  const exp = Date.now() + 15 * 60_000;
  return `/api/dev-storage/${objectPath}?exp=${exp}&sig=${sign(`up:${objectPath}:${exp}`)}`;
}

async function viewUrls(paths) {
  if (!paths.length) return {};
  if (useSupabase) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, URL_TTL_S);
    if (error) throw new Error(`Storage: ${error.message}`);
    return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
  }
  const exp = Date.now() + URL_TTL_S * 1000;
  return Object.fromEntries(paths.map((p) => [p, `/api/dev-storage/${p}?exp=${exp}&sig=${sign(`get:${p}:${exp}`)}`]));
}

async function remove(paths) {
  if (!paths.length) return;
  if (useSupabase) { await sb.storage.from(BUCKET).remove(paths); return; }
  for (const p of paths) fs.rmSync(path.join(LOCAL_DIR, p), { force: true });
}

// Dev-only handlers that mimic Supabase signed URLs.
function devRoutes(app, express) {
  if (useSupabase) return;
  const check = (kind, req) => {
    const p = req.params.path.join('/');
    const { exp, sig } = req.query;
    if (p.includes('..') || !exp || Number(exp) < Date.now() || !sig || !safeEqual(String(sig), sign(`${kind}:${p}:${exp}`))) return null;
    return p;
  };
  app.put('/api/dev-storage/*path', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
    const p = check('up', req);
    if (!p) return res.status(403).end();
    const file = path.join(LOCAL_DIR, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, req.body);
    res.json({ ok: true });
  });
  app.get('/api/dev-storage/*path', (req, res) => {
    const p = check('get', req);
    if (!p) return res.status(403).end();
    res.sendFile(path.join(LOCAL_DIR, p), { dotfiles: 'allow' });
  });
}

module.exports = { useSupabase, BUCKET, safeName, createUploadUrl, viewUrls, remove, devRoutes };
