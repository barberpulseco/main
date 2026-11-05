// Minimal Stripe Checkout client over the REST API (no SDK needed).
const crypto = require('node:crypto');

const KEY = process.env.STRIPE_SECRET_KEY;
const enabled = Boolean(KEY);

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') form(v, key, out);
    else if (v !== undefined && v !== null) out.append(key, String(v));
  }
  return out;
}

async function call(method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? form(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe error ${res.status}`);
  return json;
}

function createCheckout({ amountCents, name, description, shootId, email, successUrl, cancelUrl }) {
  return call('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { shoot_id: shootId },
    payment_intent_data: { metadata: { shoot_id: shootId } },
    line_items: { 0: { quantity: 1, price_data: { currency: 'cad', unit_amount: amountCents, product_data: { name, description } } } },
  });
}

const getCheckout = (id) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}`);

// Verifies the Stripe-Signature header (t=...,v1=...) against the raw body.
function verifyWebhook(rawBody, header, secret, toleranceS = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  if (expected.length !== parts.v1.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) return null;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceS) return null;
  return JSON.parse(rawBody);
}

module.exports = { enabled, createCheckout, getCheckout, verifyWebhook };
