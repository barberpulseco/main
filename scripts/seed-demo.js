// Fills a LOCAL database with sample barbers/shoots/payments so the dashboard has something to show.
// Refuses to run against a non-local database.
try { process.loadEnvFile?.('.env'); } catch {}
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to seed a non-local database.'); process.exit(1); }
const { q, pool } = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { getPackage } = require('../lib/packages');

(async () => {
  const shops = [
    ['AB Fades', '1355 Kingston Rd, Pickering, ON', 43.8336, -79.0868],
    ['The Social by 01', '1099 Kingston Rd, Pickering, ON', 43.8240, -79.0950],
    ['Queen West Cuts', '612 Queen St W, Toronto, ON', 43.6468, -79.4045],
    ['Danforth Barber Co.', '1960 Danforth Ave, Toronto, ON', 43.6846, -79.3150],
  ];
  const shopIds = [];
  for (const [name, address, lat, lng] of shops) {
    shopIds.push((await q.get('insert into shops (name, address, lat, lng) values ($1,$2,$3,$4) returning id', [name, address, lat, lng])).id);
  }
  const names = ['Marcus Reid', 'Jaylen Brooks', 'Andre Thompson', 'Kofi Mensah', 'Daniel Ortiz', 'Tyrese Clarke', 'Omar Haddad'];
  const ids = [];
  for (const [i, n] of names.entries()) {
    const email = `${n.split(' ')[0].toLowerCase()}@example.com`;
    ids.push((await q.get(`insert into users (name, email, phone, password_hash, shop_id, onboarded, instagram, created_at)
      values ($1,$2,$3,$4,$5,true,$6, now() - ($7 || ' days')::interval) returning id`,
      [n, email, `(416) 555-01${10 + i}`, hashPassword('password123'), shopIds[i % shopIds.length], n.split(' ')[0].toLowerCase() + '.cuts', String(i * 4)])).id);
  }
  const now = Date.now(), D = 86_400_000;
  const plan = [
    [0, 'walkin', -12, 'delivered', true], [1, 'walkin', -9, 'delivered', true], [2, 'standard', -6, 'completed', true],
    [3, 'walkin', -3, 'completed', false], [4, 'reel', -2, 'completed', false], [5, 'walkin', -1, 'delivered', true],
    [6, 'starter', 0.2, 'scheduled', false], [0, 'premium', 1.4, 'scheduled', false], [2, 'content_day', 3.6, 'scheduled', false],
    [1, 'standard', 6, 'requested', false], [3, 'walkin', -20, 'delivered', true], [4, 'walkin', -26, 'delivered', true],
  ];
  for (const [b, key, dayOff, status, paid] of plan) {
    const p = getPackage(key);
    const at = new Date(now + dayOff * D);
    at.setHours(11 + (Math.abs(dayOff * 3) % 7), 0, 0, 0);
    const user = await q.get('select shop_id from users where id = $1', [ids[b]]);
    const s = await q.get(`insert into shoots (barber_id, shop_id, package_key, package_name, price_cents, status, scheduled_at, completed_at, created_by, drive_link)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'admin',$9) returning id`,
      [ids[b], user.shop_id, key, p.name, p.price, status, at.toISOString(),
        ['completed', 'delivered'].includes(status) ? at.toISOString() : null,
        status === 'delivered' ? 'https://drive.google.com/drive/folders/example' : null]);
    if (paid) await q.run("insert into payments (shoot_id, amount_cents, method, paid_at) values ($1,$2,$3,$4)", [s.id, p.price, key === 'walkin' ? 'stripe' : 'etransfer', at.toISOString()]);
  }
  console.log(`Seeded ${names.length} barbers (password: password123), ${plan.length} shoots.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
