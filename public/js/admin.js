// Admin dashboard for Ethan: revenue, schedule, barbers, shops, photo delivery.
let CONFIG;
const state = { range: 'week', anchor: new Date(), tab: 'overview', barbers: [], barberQ: '' };
const STATUS_LABEL = { requested: 'Requested', scheduled: 'Scheduled', completed: 'Shot · editing', delivered: 'Delivered', cancelled: 'Cancelled' };
const METHOD_LABEL = { cash: 'Cash', etransfer: 'e-Transfer', stripe: 'Stripe', square: 'Square', other: 'Other', demo: 'Demo' };
const DAY = 86_400_000;

(async function init() {
  const { user } = await api('/api/me');
  if (!user) return (location.href = '/login');
  if (user.role !== 'admin') return (location.href = '/portal');
  document.getElementById('who').textContent = user.name;
  CONFIG = await api('/api/config');
  bindUI();
  const tab = location.hash.slice(1);
  showTab(['overview', 'shoots', 'barbers', 'shops'].includes(tab) ? tab : 'overview');
})().catch((e) => toast(e.message, true));

function bindUI() {
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  document.getElementById('range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]');
    if (!b) return;
    state.range = b.dataset.r;
    document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
    loadOverview();
  });
  document.getElementById('prev').onclick = () => shiftPeriod(-1);
  document.getElementById('next').onclick = () => shiftPeriod(1);
  document.getElementById('today').onclick = () => { state.anchor = new Date(); loadOverview(); };
  document.getElementById('f-status').onchange = loadShoots;
  document.getElementById('f-unpaid').onchange = loadShoots;
  document.getElementById('b-search').oninput = (e) => { state.barberQ = e.target.value.toLowerCase(); renderBarbers(); };
  document.getElementById('scrim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

function showTab(tab) {
  state.tab = tab;
  history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hide', p.dataset.panel !== tab));
  ({ overview: loadOverview, shoots: loadShoots, barbers: loadBarbers, shops: loadShops })[tab]();
}
const refresh = () => showTab(state.tab);

// ---------- period math (browser local time = Toronto for Ethan) ----------
function startOf(range, d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  if (range === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  if (range === 'month') x.setDate(1);
  return x;
}
function addPeriod(range, d, n) {
  const x = new Date(d);
  if (range === 'day') x.setDate(x.getDate() + n);
  if (range === 'week') x.setDate(x.getDate() + 7 * n);
  if (range === 'month') x.setMonth(x.getMonth() + n);
  return x;
}
function shiftPeriod(n) { state.anchor = addPeriod(state.range, startOf(state.range, state.anchor), n); loadOverview(); }
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; };
function periodLabel(range, start, end) {
  if (range === 'day') return start.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
  if (range === 'month') return start.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const last = new Date(end - 1);
  return `${start.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// ---------- overview ----------
async function loadOverview() {
  const start = startOf(state.range, state.anchor);
  const end = addPeriod(state.range, start, 1);
  document.getElementById('period-label').textContent = periodLabel(state.range, start, end);
  const data = await api(`/api/admin/overview?start=${start.toISOString()}&end=${end.toISOString()}`);
  const k = data.kpis;
  const word = { day: 'today', week: 'this week', month: 'this month' }[state.range];
  const isCurrent = startOf(state.range, new Date()).getTime() === start.getTime();
  const when = isCurrent ? word : 'in period';
  const overdue = data.due.filter((s) => new Date(s.due_at) < Date.now()).length;
  setReqCount(k.requests);
  document.getElementById('kpis').innerHTML = [
    kpi('Revenue', money(k.revenue_period), `${k.payments_period} payment${k.payments_period === 1 ? '' : 's'} ${when}`, true),
    kpi('Shoots', k.shoots_period, `scheduled ${when}`),
    kpi('Upcoming', k.upcoming_7d, 'confirmed, next 7 days'),
    kpi('Requests', k.requests, 'waiting for you to confirm'),
    kpi('Photos due', k.editing, overdue ? `${overdue} overdue` : 'all on time'),
    kpi('Outstanding', money(k.outstanding_cents), `${k.outstanding_count} shot but unpaid`),
    kpi('Barbers', k.barbers, `+${k.new_barbers_period} ${when}`),
    kpi('Shops visited', k.shops_visited, `${money(k.revenue_all)} all-time revenue`),
  ].join('');
  renderChart(start, end, data.payments);
  renderCalendar(start, end, data.shoots, data.payments);
  renderDue(data.due);
  document.getElementById('payments').innerHTML = data.payments.length
    ? data.payments.slice().reverse().map((p) => `<div><span><b>${money(p.amount_cents, { exact: true })}</b> · ${esc(p.barber_name)}<br><small class="muted">${esc(p.package_name)} · ${METHOD_LABEL[p.method] || esc(p.method)} · ${fmt.date(p.paid_at)}</small></span><button class="linkbtn" onclick="openShoot(${p.shoot_id})">View</button></div>`).join('')
    : '<p class="muted" style="font-size:14px">No payments in this period.</p>';
}
const kpi = (k, v, s, accent) => `<div class="kpi ${accent ? 'accent' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
function setReqCount(n) { const el = document.getElementById('req-count'); el.textContent = n; el.classList.toggle('hide', !n); }

function buckets(start, end) {
  const out = [];
  if (state.range === 'day') {
    for (let h = 8; h <= 22; h += 2) { const a = new Date(start); a.setHours(h); out.push({ a, b: new Date(a.getTime() + 2 * 3600_000), label: a.toLocaleTimeString('en-CA', { hour: 'numeric' }) }); }
    out[0].a = start; out[out.length - 1].b = end;
  } else {
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const a = new Date(d), b = new Date(d); b.setDate(b.getDate() + 1);
      out.push({ a, b, label: state.range === 'week' ? a.toLocaleDateString('en-CA', { weekday: 'short' }) : String(a.getDate()) });
    }
  }
  return out;
}

// Single-series bar chart (revenue per bucket) with hover tooltips.
function renderChart(start, end, payments) {
  const bs = buckets(start, end).map((b) => ({ ...b, v: payments.filter((p) => new Date(p.paid_at) >= b.a && new Date(p.paid_at) < b.b).reduce((t, p) => t + p.amount_cents, 0) }));
  const total = bs.reduce((t, b) => t + b.v, 0);
  document.getElementById('chart-title').textContent = `Revenue by ${state.range === 'day' ? 'time of day' : 'day'}`;
  document.getElementById('chart-sub').textContent = `${money(total)} total`;
  const W = 640, H = 220, L = 46, R = 8, T = 10, B = 24;
  const max = Math.max(...bs.map((b) => b.v), 0);
  const step = niceStep(max / 100 / 3) * 100; // cents
  const top = Math.max(step * 3, step * Math.ceil(max / step));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L - R) / bs.length, gap = Math.min(6, bw * 0.25);
  let grid = '';
  for (let v = 0; v <= top; v += step) grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${money(v)}</text>`;
  const every = bs.length > 16 ? 5 : 1;
  const bars = bs.map((b, i) => {
    const x = L + i * bw + gap / 2, w = bw - gap, h = Math.max(0, y(0) - y(b.v)), r = Math.min(4, w / 2, h);
    const d = h > 0 ? `M${x},${y(0)} V${y(b.v) + r} Q${x},${y(b.v)} ${x + r},${y(b.v)} H${x + w - r} Q${x + w},${y(b.v)} ${x + w},${y(b.v) + r} V${y(0)} Z` : '';
    const lbl = i % every === 0 || i === bs.length - 1 ? `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${b.label}</text>` : '';
    return `<g data-i="${i}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent"/>${d ? `<path class="bar" d="${d}"/>` : ''}${lbl}</g>`;
  }).join('');
  const el = document.getElementById('chart');
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Revenue chart, ${money(total)} total">${grid}${bars}</svg><div class="tip hide"></div>`;
  const tip = el.querySelector('.tip');
  el.querySelector('svg').addEventListener('mousemove', (e) => {
    const g = e.target.closest('g[data-i]');
    if (!g) return tip.classList.add('hide');
    const b = bs[Number(g.dataset.i)];
    const label = state.range === 'day' ? `${fmt.time(b.a)} – ${fmt.time(b.b)}` : fmt.date(b.a);
    tip.innerHTML = `<b>${money(b.v, { exact: true })}</b>${label}`;
    const r = el.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left}px`; tip.style.top = `${e.clientY - r.top}px`;
    tip.classList.remove('hide');
  });
  el.querySelector('svg').addEventListener('mouseleave', () => tip.classList.add('hide'));
}
function niceStep(raw) {
  if (raw <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function agendaItem(s) {
  return `<button class="agenda-item" onclick="openShoot(${s.id})">
    <span class="when">${fmt.time(s.scheduled_at) || '—'}<small>${fmt.date(s.scheduled_at)}</small></span>
    <span class="what"><b>${esc(s.barber_name)}</b><small>${esc(s.package_name)} · ${esc(s.shop_name || 'No shop')}</small></span>
    <span class="row" style="gap:6px">${s.balance_cents ? `<span class="pill owing">${money(s.balance_cents)}</span>` : '<span class="pill paid">Paid</span>'}<span class="pill ${s.status}">${STATUS_LABEL[s.status]}</span></span>
  </button>`;
}

function renderCalendar(start, end, shoots, payments) {
  const el = document.getElementById('calendar');
  document.getElementById('cal-title').textContent = `Shoots ${state.range === 'day' ? 'today' : state.range === 'week' ? 'this week' : 'this month'}`;
  if (state.range === 'month') {
    const first = startOf('week', start);
    const today = dayKey(new Date());
    let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
    for (let d = new Date(first); d < end || d.getDay() !== 1; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d);
      const ds = shoots.filter((s) => dayKey(s.scheduled_at) === key);
      const rev = payments.filter((p) => dayKey(p.paid_at) === key).reduce((t, p) => t + p.amount_cents, 0);
      html += `<button class="day ${d < start || d >= end ? 'out' : ''} ${key === today ? 'today' : ''} ${ds.length ? 'has' : ''}" data-d="${d.toISOString()}">
        <span class="d">${d.getDate()}</span>${ds.slice(0, 2).map((s) => `<span class="chip">${fmt.time(s.scheduled_at)} ${esc(s.barber_name.split(' ')[0])}</span>`).join('')}${ds.length > 2 ? `<span class="chip">+${ds.length - 2}</span>` : ''}
        ${rev ? `<span class="rev">${money(rev)}</span>` : ''}</button>`;
    }
    el.innerHTML = `<div class="month-grid">${html}</div><p class="muted" style="font-size:12px;margin-top:8px">Tap a day to open it.</p>`;
    el.querySelectorAll('.day').forEach((b) => b.onclick = () => {
      state.range = 'day'; state.anchor = new Date(b.dataset.d);
      document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x.dataset.r === 'day'));
      loadOverview();
    });
    return;
  }
  if (!shoots.length) { el.innerHTML = '<p class="muted" style="font-size:14px;margin-top:8px">Nothing on the calendar.</p>'; return; }
  if (state.range === 'day') { el.innerHTML = `<div class="agenda">${shoots.map(agendaItem).join('')}</div>`; return; }
  const groups = {};
  shoots.forEach((s) => (groups[dayKey(s.scheduled_at)] ||= []).push(s));
  el.innerHTML = Object.values(groups).map((g) => `<p class="daygroup">${fmt.date(g[0].scheduled_at)}</p><div class="agenda">${g.map(agendaItem).join('')}</div>`).join('');
}

function renderDue(due) {
  const el = document.getElementById('due');
  if (!due.length) { el.innerHTML = '<p class="muted" style="font-size:14px">All caught up.</p>'; return; }
  el.innerHTML = due.map((s) => {
    const days = Math.ceil((new Date(s.due_at) - Date.now()) / DAY);
    const tag = days < 0 ? `<span class="pill owing">${-days}d overdue</span>` : `<span class="pill requested">${days === 0 ? 'today' : `in ${days}d`}</span>`;
    return `<button class="agenda-item" onclick="openShoot(${s.id})" style="grid-template-columns:1fr auto">
      <span class="what"><b>${esc(s.barber_name)}${s.rush ? ' · RUSH' : ''}</b><small>${esc(s.package_name)} · ${s.photo_count} photos · due ${fmt.date(s.due_at)}${s.drive_link ? '' : ' · no Drive link yet'}</small></span>${tag}</button>`;
  }).join('');
}

// ---------- shoots ----------
async function loadShoots() {
  const st = document.getElementById('f-status').value, unpaid = document.getElementById('f-unpaid').checked;
  const { shoots } = await api(`/api/admin/shoots?${new URLSearchParams({ ...(st && { status: st }), ...(unpaid && { unpaid: '1' }) })}`);
  setReqCount(shoots.filter((s) => s.status === 'requested').length || Number(document.getElementById('req-count').textContent) || 0);
  document.getElementById('shoots-body').innerHTML = shoots.length ? shoots.map((s) => `
    <tr class="click" onclick="openShoot(${s.id})">
      <td>${s.scheduled_at ? `<b>${fmt.date(s.scheduled_at)}</b><br><small class="muted">${fmt.time(s.scheduled_at)}</small>` : '<span class="muted">Not set</span>'}</td>
      <td><b>${esc(s.barber_name)}</b><br><small class="muted">${esc(s.barber_phone || '')}</small></td>
      <td>${esc(s.shop_name || '—')}</td>
      <td>${esc(s.package_name)}${s.rush ? ' <span class="tag rust">Rush</span>' : ''}</td>
      <td><span class="pill ${s.status}">${STATUS_LABEL[s.status]}</span></td>
      <td class="num">${money(s.price_cents)}</td><td class="num">${money(s.paid_cents)}</td>
      <td class="num">${s.balance_cents && s.status !== 'cancelled' ? `<b style="color:var(--bad)">${money(s.balance_cents)}</b>` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">No shoots match.</td></tr>';
}

function openDrawer(title, html) {
  document.getElementById('d-title').textContent = title;
  document.getElementById('d-body').innerHTML = html;
  document.getElementById('drawer').classList.remove('hide');
  document.getElementById('scrim').classList.remove('hide');
}
function closeDrawer() {
  if (document.getElementById('drawer').classList.contains('hide')) return;
  document.getElementById('drawer').classList.add('hide');
  document.getElementById('scrim').classList.add('hide');
}

async function openShoot(id) {
  const { shoot: s, photos, payments } = await api(`/api/admin/shoots/${id}`);
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  openDrawer(`${s.package_name} · ${s.barber_name}`, `
    <div class="card">
      <div class="shoot-head"><h3>Barber</h3>${mapLinks({ name: s.shop_name, address: s.shop_address, lat: s.shop_lat, lng: s.shop_lng })}</div>
      <p style="margin-top:6px"><b>${esc(s.barber_name)}</b> · <a href="tel:${esc(s.barber_phone)}">${esc(s.barber_phone || '')}</a> · <a href="mailto:${esc(s.barber_email)}">${esc(s.barber_email)}</a>${s.barber_instagram ? ` · <a href="https://instagram.com/${esc(s.barber_instagram)}" target="_blank" rel="noopener">@${esc(s.barber_instagram)}</a>` : ''}</p>
      <p class="muted" style="font-size:14px">${esc(s.shop_name || 'No shop')} ${s.shop_address ? `· ${esc(s.shop_address)}` : ''}</p>
      ${s.notes ? `<p style="margin-top:8px;font-size:14px"><b>Barber's note:</b> ${esc(s.notes)}</p>` : ''}
      ${s.addons.length ? `<p style="margin-top:6px;font-size:14px"><b>Add-ons:</b> ${s.addons.map((a) => esc(a.name)).join(', ')}</p>` : ''}
    </div>

    <form class="card" id="sf">
      <h3>Shoot</h3>
      <div class="grid2">
        <div class="field"><label>Status</label><select name="status">${opts(Object.entries(STATUS_LABEL), s.status)}</select></div>
        <div class="field"><label>Date &amp; time</label><input type="datetime-local" name="scheduled_at" value="${toLocalInput(s.scheduled_at)}"></div>
        <div class="field"><label>Price (CAD)</label><input type="number" min="0" step="0.01" name="price" value="${(s.price_cents / 100).toFixed(2)}"></div>
        <div class="field"><label>Free preview photos</label><input type="number" min="0" max="20" name="preview_count" value="${s.preview_count}"><span class="hint">Shown before they pay</span></div>
      </div>
      <div class="field"><label>Private notes</label><textarea name="admin_notes" placeholder="Only you see this">${esc(s.admin_notes || '')}</textarea></div>
      <div class="row" style="margin-top:12px"><button class="btn btn-primary btn-sm">Save shoot</button>
        ${s.status === 'requested' ? '<button type="button" class="btn btn-dark btn-sm" id="confirm-btn">Confirm this time</button>' : ''}</div>
    </form>

    <form class="card" id="df">
      <h3>Google Drive folder</h3>
      <p class="muted" style="font-size:13px">The barber sees this link once the shoot is paid in full.</p>
      <div class="row" style="margin-top:8px"><input class="grow" type="url" name="drive_link" placeholder="https://drive.google.com/drive/folders/…" value="${esc(s.drive_link || '')}"><button class="btn btn-primary btn-sm">Save link</button></div>
      ${s.drive_link ? `<p style="margin-top:8px;font-size:14px"><a href="${esc(s.drive_link)}" target="_blank" rel="noopener">Open folder ↗</a></p>` : ''}
    </form>

    <div class="card">
      <div class="shoot-head"><h3>Photos (${photos.length})</h3><span class="muted" style="font-size:13px">${s.unlocked ? 'Unlocked — barber sees all' : `Barber sees ${photos.some((p) => p.is_preview) ? 'starred' : `first ${s.preview_count}`} free`}</span></div>
      <label class="dropzone" id="dz" style="display:block;margin-top:10px">Drop photos here or <u>choose files</u><input type="file" id="files" accept="image/*" multiple class="sr"></label>
      <p class="muted" id="up-status" style="font-size:13px;margin-top:6px"></p>
      <div class="photo-admin">${photos.map((p) => `
        <div class="p ${p.is_preview ? 'preview' : ''}"><img src="${esc(p.url)}" alt="" loading="lazy">
          <div class="ctl"><button type="button" onclick="togglePreview(${p.id}, ${!p.is_preview}, ${s.id})">${p.is_preview ? '★ Free' : '☆ Free'}</button><button type="button" onclick="delPhoto(${p.id}, ${s.id})">✕</button></div></div>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin-top:8px">★ = always shown free. If none are starred, the first ${s.preview_count} are free.</p>
    </div>

    <div class="card">
      <div class="shoot-head"><h3>Payments</h3><span>${s.balance_cents ? `<span class="pill owing">Owes ${money(s.balance_cents, { exact: true })}</span>` : '<span class="pill paid">Paid in full</span>'}</span></div>
      <div class="pay-list">${payments.map((p) => `<div><span><b>${money(p.amount_cents, { exact: true })}</b> · ${METHOD_LABEL[p.method] || esc(p.method)} · ${fmt.dateY(p.paid_at)}${p.note ? `<br><small class="muted">${esc(p.note)}</small>` : ''}</span><button class="linkbtn" onclick="delPayment(${p.id}, ${s.id})">Remove</button></div>`).join('') || '<p class="muted" style="font-size:14px">No payments yet.</p>'}</div>
      <form id="pf" class="row" style="margin-top:10px">
        <input type="number" name="amount" min="0" step="0.01" placeholder="Amount" value="${s.balance_cents ? (s.balance_cents / 100).toFixed(2) : ''}" style="width:110px">
        <select name="method" style="width:auto">${opts([['cash', 'Cash'], ['etransfer', 'e-Transfer'], ['square', 'Square'], ['stripe', 'Stripe'], ['other', 'Other']], 'cash')}</select>
        <input type="text" name="note" placeholder="Note (optional)" class="grow">
        <button class="btn btn-primary btn-sm">Record payment</button>
      </form>
    </div>
    <button class="linkbtn" style="color:var(--bad);justify-self:start" onclick="delShoot(${s.id})">Delete this shoot</button>`);

  const sf = document.getElementById('sf');
  sf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/shoots/${id}`, { method: 'PATCH', body: {
        status: sf.status.value, scheduled_at: fromLocalInput(sf.scheduled_at.value), price_cents: Math.round(Number(sf.price.value) * 100),
        preview_count: Number(sf.preview_count.value), admin_notes: sf.admin_notes.value } });
      toast('Shoot saved'); openShoot(id); refresh();
    } catch (err) { toast(err.message, true); }
  };
  document.getElementById('confirm-btn')?.addEventListener('click', () => { sf.status.value = 'scheduled'; sf.requestSubmit(); });
  const df = document.getElementById('df');
  df.onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/api/admin/shoots/${id}`, { method: 'PATCH', body: { drive_link: df.drive_link.value } }); toast('Drive link saved'); openShoot(id); } catch (err) { toast(err.message, true); }
  };
  const pf = document.getElementById('pf');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/shoots/${id}/payments`, { method: 'POST', body: { amount_cents: Math.round(Number(pf.amount.value) * 100), method: pf.method.value, note: pf.note.value } });
      toast('Payment recorded'); openShoot(id); refresh();
    } catch (err) { toast(err.message, true); }
  };
  const dz = document.getElementById('dz'), fi = document.getElementById('files');
  fi.onchange = () => uploadPhotos(id, fi.files);
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); uploadPhotos(id, e.dataTransfer.files); };
}

async function uploadPhotos(shootId, fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const status = document.getElementById('up-status');
  try {
    status.textContent = `Preparing ${files.length} upload${files.length > 1 ? 's' : ''}…`;
    const { uploads } = await api(`/api/admin/shoots/${shootId}/photos/sign`, { method: 'POST', body: { files: files.map((f) => ({ name: f.name })) } });
    const done = [];
    let i = 0;
    await Promise.all(uploads.map(async (u, idx) => {
      const f = files[idx];
      const r = await fetch(u.url, { method: 'PUT', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream', 'x-upsert': 'false' } });
      if (!r.ok) throw new Error(`Upload failed for ${f.name}`);
      done.push({ path: u.path, name: f.name });
      status.textContent = `Uploaded ${++i} of ${files.length}…`;
    }));
    await api(`/api/admin/shoots/${shootId}/photos`, { method: 'POST', body: { photos: done } });
    toast(`${done.length} photo${done.length > 1 ? 's' : ''} added`);
    openShoot(shootId);
  } catch (e) { status.textContent = e.message; toast(e.message, true); }
}
async function togglePreview(pid, on, sid) { await api(`/api/admin/photos/${pid}`, { method: 'PATCH', body: { is_preview: on } }); openShoot(sid); }
async function delPhoto(pid, sid) { if (!confirm('Delete this photo?')) return; await api(`/api/admin/photos/${pid}`, { method: 'DELETE' }); openShoot(sid); }
async function delPayment(pid, sid) { if (!confirm('Remove this payment?')) return; await api(`/api/admin/payments/${pid}`, { method: 'DELETE' }); openShoot(sid); refresh(); }
async function delShoot(sid) {
  if (!confirm('Delete this shoot, its photos and payments? This cannot be undone.')) return;
  await api(`/api/admin/shoots/${sid}`, { method: 'DELETE' }); closeDrawer(); refresh();
}

async function newShoot({ walkin = false, barberId } = {}) {
  if (!state.barbers.length) state.barbers = (await api('/api/admin/barbers')).barbers;
  const pk = CONFIG.packages.map((p) => `<option value="${p.key}" ${walkin && p.key === 'walkin' ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)}</option>`).join('');
  openDrawer(walkin ? 'Log a walk-in' : 'New shoot', `
    <form class="card" id="nf">
      ${walkin ? '<p class="muted" style="font-size:14px">Barber not in the list? Have them sign up at <b>barberpulse.co/signup</b> on their phone first, or add them under Barbers.</p>' : ''}
      <div class="field"><label>Barber</label><select name="barber" required><option value="">Choose…</option>${state.barbers.map((b) => `<option value="${b.id}" ${b.id === barberId ? 'selected' : ''}>${esc(b.name)} — ${esc(b.shop_name || 'no shop')}</option>`).join('')}</select></div>
      <div class="field"><label>Package</label><select name="pkg">${pk}</select></div>
      <div class="field"><label>Add-ons</label>${CONFIG.addons.map((a) => `<label class="check"><input type="checkbox" value="${a.key}"><span>${esc(a.name)}</span><span class="price">+${money(a.price)}</span></label>`).join('')}</div>
      <div class="grid2">
        <div class="field"><label>Status</label><select name="status">${Object.entries(STATUS_LABEL).filter(([k]) => k !== 'cancelled').map(([k, l]) => `<option value="${k}" ${(walkin ? 'completed' : 'scheduled') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Date &amp; time</label><input type="datetime-local" name="when" value="${toLocalInput(new Date().toISOString())}"></div>
      </div>
      <div class="field"><label>Custom price (CAD) <span class="muted">optional</span></label><input type="number" name="price" min="0" step="0.01" placeholder="Uses package price"></div>
      <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
      <button class="btn btn-primary" style="margin-top:14px">Create shoot</button>
    </form>`);
  const nf = document.getElementById('nf');
  nf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/shoots', { method: 'POST', body: {
        barber_id: Number(nf.barber.value), package_key: nf.pkg.value, status: nf.status.value,
        addons: [...nf.querySelectorAll('.check input:checked')].map((i) => i.value),
        scheduled_at: fromLocalInput(nf.when.value), notes: nf.notes.value,
        price_cents: nf.price.value === '' ? undefined : Math.round(Number(nf.price.value) * 100) } });
      toast('Shoot created'); refresh(); openShoot(r.id);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- barbers ----------
async function loadBarbers() { state.barbers = (await api('/api/admin/barbers')).barbers; renderBarbers(); }
function renderBarbers() {
  const q = state.barberQ;
  const rows = state.barbers.filter((b) => !q || `${b.name} ${b.email} ${b.phone} ${b.shop_name}`.toLowerCase().includes(q));
  document.getElementById('barbers-body').innerHTML = rows.length ? rows.map((b) => `
    <tr class="click" onclick="openBarber(${b.id})">
      <td><b>${esc(b.name)}</b>${b.instagram ? `<br><small class="muted">@${esc(b.instagram)}</small>` : ''}</td>
      <td>${esc(b.phone || '')}<br><small class="muted">${esc(b.email)}</small></td>
      <td>${esc(b.shop_name || '—')}</td>
      <td class="num">${b.shoots}</td><td class="num">${money(b.paid_cents)}</td>
      <td class="num">${b.owing_cents ? `<b style="color:var(--bad)">${money(b.owing_cents)}</b>` : '—'}</td>
      <td>${fmt.dateY(b.created_at)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">No barbers yet. Share barberpulse.co/signup.</td></tr>';
}
async function openBarber(id) {
  const b = state.barbers.find((x) => x.id === id);
  const { shoots } = await api(`/api/admin/shoots?barber_id=${id}`);
  openDrawer(b.name, `
    <div class="card">
      <p><a href="tel:${esc(b.phone)}">${esc(b.phone || 'No phone')}</a> · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p>
      <p class="muted" style="font-size:14px;margin-top:4px">${esc(b.shop_name || 'No shop')} ${b.shop_address ? `· ${esc(b.shop_address)}` : ''}</p>
      <div style="margin-top:6px">${b.shop_name ? mapLinks({ name: b.shop_name, address: b.shop_address }) : ''}</div>
      <div class="kpis" style="margin:14px 0 0"><div class="kpi"><div class="k">Paid</div><div class="v">${money(b.paid_cents)}</div></div><div class="kpi"><div class="k">Owing</div><div class="v">${money(b.owing_cents)}</div></div></div>
      <div class="row" style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="newShoot({ barberId: ${b.id} })">New shoot</button><button class="btn btn-sm" onclick="newShoot({ walkin: true, barberId: ${b.id} })">Log walk-in</button><button class="btn btn-sm" onclick="resetPw(${b.id})">Reset password</button></div>
    </div>
    <div class="card"><h3>Shoots</h3><div class="agenda">${shoots.map(agendaItem).join('') || '<p class="muted">None yet.</p>'}</div></div>`);
}
async function resetPw(id) {
  if (!confirm('Generate a new temporary password for this barber?')) return;
  const r = await api(`/api/admin/barbers/${id}/reset-password`, { method: 'POST' });
  prompt('New temporary password (send it to the barber):', r.temp_password);
}
function addBarber() {
  openDrawer('Add a barber', `
    <form class="card" id="bf">
      <p class="muted" style="font-size:14px">Best: have the barber sign up at barberpulse.co/signup themselves. Use this when they can't right now. You'll get a temporary password to give them.</p>
      <div class="field"><label>Name</label><input name="name" type="text" required></div>
      <div class="field"><label>Email</label><input name="email" type="email" required></div>
      <div class="field"><label>Phone</label><input name="phone" type="tel"></div>
      <div class="field"><label>Shop name</label><input name="shop" type="text"></div>
      <div class="field"><label>Shop address</label><input name="addr" type="text"></div>
      <button class="btn btn-primary" style="margin-top:14px">Add barber</button>
    </form>`);
  const f = document.getElementById('bf');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/barbers', { method: 'POST', body: { name: f.name.value, email: f.email.value, phone: f.phone.value,
        shop: f.shop.value ? { name: f.shop.value, address: f.addr.value } : null } });
      prompt('Barber added. Temporary password to give them:', r.temp_password);
      closeDrawer(); loadBarbers();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- shops ----------
async function loadShops() {
  const { shops } = await api('/api/admin/shops');
  document.getElementById('shops-body').innerHTML = shops.length ? shops.map((s) => `
    <tr>
      <td><b>${esc(s.name)}</b><br>${mapLinks(s)}</td>
      <td>${esc(s.address || '—')}</td>
      <td class="num">${s.barbers}</td><td class="num">${s.visits}</td>
      <td>${s.last_visit ? fmt.dateY(s.last_visit) : '<span class="muted">Not yet</span>'}</td>
      <td>${s.next_visit ? fmt.dt(s.next_visit) : '—'}</td>
      <td class="num">${money(s.revenue_cents)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">No shops yet.</td></tr>';
}
