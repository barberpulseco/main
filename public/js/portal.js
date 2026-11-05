let CONFIG, ME, otherPicker;

(async function init() {
  const { user } = await api('/api/me');
  if (!user) return (location.href = '/login');
  if (user.role === 'admin') return (location.href = '/admin');
  if (!user.onboarded) return (location.href = '/signup');
  ME = user;
  CONFIG = await api('/api/config');
  document.getElementById('who').textContent = user.email;
  document.getElementById('hello').textContent = `Hey ${user.name.split(' ')[0]}`;
  renderShop();
  setupBooking();
  await handleReturnFromStripe();
  loadShoots();
})().catch((e) => toast(e.message, true));

function renderShop() {
  const s = ME.shop;
  document.getElementById('shop-card').innerHTML = `
    <div class="shoot-head">
      <div><p class="eyebrow">Where you cut</p><h3 style="margin-top:4px;font-size:18px">${esc(s?.name || 'No shop set')}</h3>
      <p class="muted" style="font-size:14px">${esc(s?.address || '')}</p></div>
      <div>${mapLinks(s)}</div>
    </div>`;
}

async function handleReturnFromStripe() {
  const p = new URLSearchParams(location.search);
  const banner = document.getElementById('banner');
  if (p.get('paid')) {
    try { await api('/api/stripe/confirm', { method: 'POST', body: { session_id: p.get('paid') } }); } catch {}
    banner.innerHTML = '<div class="banner ok"><b>Payment received.</b> Your full photo set is unlocked below.</div>';
  } else if (p.get('cancelled')) {
    banner.innerHTML = '<div class="banner">Payment cancelled. Your photos are still waiting whenever you are ready.</div>';
  }
  if (p.toString()) history.replaceState(null, '', location.pathname + location.hash);
}

async function loadShoots() {
  const { shoots } = await api('/api/my/shoots');
  const el = document.getElementById('shoots');
  if (!shoots.length) {
    el.innerHTML = `<div class="card empty"><b>No shoots yet</b>When we shoot you, your photos show up here. Want one now? <a href="#book">Book a shoot</a>.</div>`;
    return;
  }
  el.innerHTML = shoots.map(shootCard).join('');
}

function shootCard(s) {
  const total = s.photos.length + s.locked_count;
  const statusText = { requested: 'Requested — waiting for confirmation', scheduled: 'Confirmed', completed: 'Shot — editing in progress', delivered: 'Delivered', cancelled: 'Cancelled' }[s.status];
  const locked = Array.from({ length: Math.min(s.locked_count, 6) }, (_, i) =>
    `<div class="ph locked"><span>🔒${i === Math.min(s.locked_count, 6) - 1 && s.locked_count > 6 ? `<small>+${s.locked_count - 5} more</small>` : ''}</span></div>`).join('');
  const photos = s.photos.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="Photo from your shoot" loading="lazy"></a>`).join('');
  let action = '';
  if (s.status !== 'cancelled' && s.balance_cents > 0 && (s.status === 'completed' || s.status === 'delivered' || total > 0)) {
    action = `<div class="paywall">
      <div><b>${s.locked_count ? `${s.locked_count} more photo${s.locked_count === 1 ? '' : 's'} waiting` : 'Unlock your full set'}</b>
      <p>${s.package_key === 'walkin' ? 'Walk-in special — unlock every edited photo for' : 'Balance due'} ${money(s.balance_cents)}${s.has_drive_link ? ' · includes your full-resolution Google Drive folder' : ''}</p></div>
      <button class="btn btn-primary" onclick="pay(${s.id}, this)">Unlock for ${money(s.balance_cents)}</button></div>`;
  } else if (s.unlocked && s.drive_link) {
    action = `<div class="paywall" style="background:var(--good)"><div><b>Your full set is ready</b><p style="color:#e3f2e7">All edited, full-resolution files in Google Drive.</p></div>
      <a class="btn" style="border-color:#fff;color:#fff" href="${esc(s.drive_link)}" target="_blank" rel="noopener">Open Google Drive</a></div>`;
  }
  const cancel = s.status === 'requested' ? `<button class="linkbtn" onclick="cancelReq(${s.id})">Cancel request</button>` : '';
  return `<article class="card shoot">
    <div class="shoot-head">
      <div><h3 style="font-size:18px">${esc(s.package_name)}</h3>
        <div class="meta"><span>${esc(fmt.dt(s.scheduled_at))}</span><span>${esc(s.shop_name || '')}</span><span>${statusText}</span></div></div>
      <div class="row">${s.unlocked && s.price_cents > 0 ? '<span class="pill paid">Paid</span>' : ''}<span class="pill ${s.status}">${s.status}</span>${cancel}</div>
    </div>
    ${total ? `<div class="gallery">${photos}${locked}</div>` : (s.status === 'completed' ? '<p class="muted" style="margin-top:10px">Your photos are being edited. Check back soon.</p>' : '')}
    ${action}
  </article>`;
}

async function pay(id, btn) {
  busy(btn, true, 'Opening checkout…');
  try {
    const r = await api(`/api/my/shoots/${id}/checkout`, { method: 'POST' });
    if (r.url) return (location.href = r.url);
    toast('Unlocked!');
    loadShoots();
  } catch (e) { toast(e.message, true); }
  busy(btn, false);
}

async function cancelReq(id) {
  if (!confirm('Cancel this shoot request?')) return;
  try { await api(`/api/my/shoots/${id}/cancel`, { method: 'POST' }); loadShoots(); } catch (e) { toast(e.message, true); }
}

function setupBooking() {
  const groups = { photography: 'Photography', videography: 'Videography', walkin: 'Walk-in' };
  const sel = document.getElementById('pkg');
  sel.innerHTML = '<option value="">Choose a package…</option>' + Object.entries(groups).map(([g, label]) =>
    `<optgroup label="${label}">${CONFIG.packages.filter((p) => p.group === g).map((p) => `<option value="${p.key}">${esc(p.name)} — ${money(p.price)}</option>`).join('')}</optgroup>`).join('');
  document.getElementById('addons').innerHTML = CONFIG.addons.map((a) =>
    `<label class="check"><input type="checkbox" value="${a.key}"><span>${esc(a.name)}</span><span class="price">+${money(a.price)}</span></label>`).join('');
  const when = document.getElementById('when');
  when.min = toLocalInput(new Date().toISOString());
  const total = () => {
    const p = CONFIG.packages.find((x) => x.key === sel.value);
    document.getElementById('pkg-detail').textContent = p ? p.detail : '';
    const add = [...document.querySelectorAll('#addons input:checked')].reduce((t, i) => t + CONFIG.addons.find((a) => a.key === i.value).price, 0);
    document.getElementById('total').textContent = money((p?.price || 0) + add);
  };
  document.getElementById('bf').addEventListener('change', total);
  const where = document.getElementById('where'), other = document.getElementById('other-shop');
  where.addEventListener('change', () => {
    other.classList.toggle('hide', where.value !== 'other');
    if (where.value === 'other' && !otherPicker) otherPicker = shopPicker(other);
  });
  document.getElementById('bf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('berr');
    err.textContent = '';
    const shop = where.value === 'other' ? otherPicker?.get() : null;
    if (where.value === 'other' && !shop) { err.textContent = 'Pick or enter the location for this shoot.'; return; }
    const btn = e.target.querySelector('button.btn-primary');
    busy(btn, true, 'Sending…');
    try {
      await api('/api/my/bookings', { method: 'POST', body: {
        package_key: sel.value, addons: [...document.querySelectorAll('#addons input:checked')].map((i) => i.value),
        preferred_at: fromLocalInput(when.value), notes: document.getElementById('notes').value, shop } });
      e.target.reset(); total();
      toast('Request sent! Ethan will confirm your slot.');
      await loadShoots();
      document.getElementById('shoots').scrollIntoView({ behavior: 'smooth' });
    } catch (ex) { err.textContent = ex.message; }
    busy(btn, false);
  });
}
