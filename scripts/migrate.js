// Applies supabase/schema.sql to DATABASE_URL. Safe to re-run.
try { process.loadEnvFile?.('.env'); } catch {}
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../lib/db');
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  console.log('Schema applied.');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
