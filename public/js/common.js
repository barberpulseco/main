// Shared helpers for every app page.
// Dates render in the viewer's local time zone (Toronto for Ethan and the barbers).

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const money = (cents, opts = {}) => new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', maximumFractionDigits: cents % 100 === 0 && !opts.exact ? 0 : 2,
}).format((cents || 0) / 100);

const fmt = {
  date: (d) => d ? new Date(d).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '—',
  dateY: (d) => d ? new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
  time: (d) => d ? new Date(d).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '',
  dt: (d) => d ? `${fmt.date(d)} · ${fmt.time(d)}` : 'Not scheduled',
};

// "2026-11-05T14:30" for <input type=datetime-local>, in the browser's local zone
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isErr = false) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hide'), 3500);
}

function mapLinks(shop) {
  if (!shop) return '';
  const q = encodeURIComponent([shop.name, shop.address].filter(Boolean).join(', '));
  const ll = shop.lat != null && shop.lng != null ? `${shop.lat},${shop.lng}` : '';
  const g = `https://www.google.com/maps/search/?api=1&query=${ll ? encodeURIComponent(ll) : q}`;
  const a = `https://maps.apple.com/?q=${encodeURIComponent(shop.name || 'Barbershop')}${ll ? `&ll=${ll}` : `&address=${q}`}`;
  return `<span class="maplinks"><a href="${g}" target="_blank" rel="noopener">Google Maps</a><a href="${a}" target="_blank" rel="noopener">Apple Maps</a></span>`;
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.textContent = label || 'Working…'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

// Geolocation + nearby/search shop picker, used in onboarding and booking.
function shopPicker(root, { onChange } = {}) {
  root.innerHTML = `
    <div class="row">
      <button type="button" class="btn btn-dark btn-sm" data-geo>📍 Find shops near me</button>
      <span class="muted" style="font-size:13px">or search by name / address</span>
    </div>
    <div class="field"><label class="sr" for="shop-q">Search shops</label>
      <input id="shop-q" type="search" placeholder="e.g. AB Fades Pickering, or 123 Queen St W" autocomplete="off"></div>
    <p class="muted" data-status style="font-size:13px;margin-top:8px"></p>
    <div class="shop-list" data-list></div>
    <details data-manual style="margin-top:12px">
      <summary class="linkbtn" style="list-style:none">Can't find it? Enter the shop manually</summary>
      <div class="field"><label for="m-name">Shop name</label><input id="m-name" type="text" placeholder="Shop name"></div>
      <div class="field"><label for="m-addr">Shop address</label><input id="m-addr" type="text" placeholder="Street, city" autocomplete="street-address"></div>
    </details>`;
  const list = root.querySelector('[data-list]');
  const status = root.querySelector('[data-status]');
  const mName = root.querySelector('#m-name'), mAddr = root.querySelector('#m-addr');
  let selected = null, results = [];

  const render = () => {
    list.innerHTML = results.map((s, i) => `
      <button type="button" class="shop-opt ${selected === s ? 'sel' : ''}" data-i="${i}">
        <b>${esc(s.name)} ${s.source === 'existing' ? '<span class="tag rust">On Barber Pulse</span>' : ''}</b>
        <small>${esc(s.address || 'Address not listed')}</small>
      </button>`).join('');
  };
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.shop-opt');
    if (!b) return;
    selected = results[Number(b.dataset.i)];
    mName.value = ''; mAddr.value = '';
    render();
    onChange?.(selected);
  });
  [mName, mAddr].forEach((el) => el.addEventListener('input', () => { selected = null; render(); onChange?.(get()); }));

  root.querySelector('[data-geo]').addEventListener('click', (e) => {
    if (!navigator.geolocation) { status.textContent = 'Location is not available on this device. Search instead.'; return; }
    busy(e.currentTarget, true, 'Locating…');
    const btn = e.currentTarget;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        status.textContent = 'Looking for barbershops near you…';
        const { shops } = await api(`/api/shops/nearby?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`);
        results = shops;
        status.textContent = shops.length ? 'Tap your shop:' : 'No shops found nearby. Search or enter it manually.';
        if (!shops.length) root.querySelector('[data-manual]').open = true;
        render();
      } catch (err) { status.textContent = err.message; }
      busy(btn, false);
    }, () => {
      busy(btn, false);
      status.textContent = 'Location permission denied. Search or enter your shop manually.';
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  let t;
  root.querySelector('#shop-q').addEventListener('input', (e) => {
    clearTimeout(t);
    const v = e.target.value.trim();
    if (v.length < 3) return;
    t = setTimeout(async () => {
      status.textContent = 'Searching…';
      try {
        const r = await api(`/api/shops/search?q=${encodeURIComponent(v)}`);
        results = r.shops;
        status.textContent = r.warning || (r.shops.length ? 'Tap your shop:' : 'No matches. Enter it manually below.');
        if (!r.shops.length) root.querySelector('[data-manual]').open = true;
        render();
      } catch (err) { status.textContent = err.message; }
    }, 450);
  });

  function get() {
    if (selected) return selected;
    if (mName.value.trim()) return { name: mName.value.trim(), address: mAddr.value.trim(), source: 'manual' };
    return null;
  }
  return { get };
}
