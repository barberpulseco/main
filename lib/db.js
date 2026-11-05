const { Pool, types } = require('pg');

// bigint ids → JS numbers (ids will never exceed 2^53)
types.setTypeParser(20, (v) => Number(v));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Use the Supabase connection string (Transaction pooler, port 6543).');

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 3), // serverless: keep it small
  idleTimeoutMillis: 10_000,
});

const q = {
  async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
  async get(sql, params = []) { return (await pool.query(sql, params)).rows[0] || null; },
  async run(sql, params = []) { return pool.query(sql, params); },
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn({
        all: async (s, p = []) => (await client.query(s, p)).rows,
        get: async (s, p = []) => (await client.query(s, p)).rows[0] || null,
        run: (s, p = []) => client.query(s, p),
      });
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};

module.exports = { pool, q };
