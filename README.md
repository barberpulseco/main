# Barber Pulse — barberpulse.co

Landing page, barber portal and admin dashboard for **Barber Pulse Toronto** (@barberpulse.to).

- **Landing** (`/`): the why (Supply / Demand / Trust / Distribution), how it works, the Content Packages menu, the $20 Walk-in Special and Barber of the Block.
- **Barber sign-up** (`/signup`): name, email, phone, password → their shop (📍 nearby barbershops from their location, search, or manual entry) → Instagram.
- **Barber portal** (`/portal`): previews of their photos, the rest locked behind a Stripe paywall ($20 for walk-ins, or whatever balance is owed), the Google Drive link after payment, booking another shoot, and Google Maps / Apple Maps links to their shop.
- **Admin** (`/admin`, Ethan): revenue and shoots by day / week / month, a calendar, photos due, outstanding balances, requests to confirm, barbers, shops visited, photo uploads, Drive links, and recording cash / e-Transfer payments.

**Stack:** GitHub → Vercel (static pages + one Express serverless function at `/api`) → Supabase Postgres (data) + Supabase Storage (photos, private bucket). Stripe Checkout for payments. No frontend build step.

## How the walk-in flow works

1. Ethan walks in and shoots. The barber signs up on their phone at **barberpulse.co/signup**.
2. In Admin → Shoots, Ethan clicks **+ Walk-in ($20)**, picks the barber, uploads the photos, and pastes the Google Drive folder link.
3. The barber sees the first 3 photos for free (Ethan can change the number, or ★ star specific photos). The rest are blurred and locked.
4. The barber taps **Unlock for $20** and pays with Stripe. All the photos and the Drive link unlock right away, and the payment shows up in Ethan's revenue.

Locked photos are never sent to the browser. Every photo is served through a signed link that expires after 1 hour.

---

## Deploy (about 15 minutes)

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com) (region: **Canada (Central)**).
2. **SQL Editor** → paste all of `supabase/schema.sql` → **Run**.
3. Copy these values (you'll need them in step 3):
   - **Project Settings → Database → Connection string → Transaction pooler** (port 6543) → `DATABASE_URL`, with your DB password filled in.
   - **Project Settings → API** → Project URL → `SUPABASE_URL`, and the `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`.

   The private `shoot-photos` storage bucket is created automatically on the first upload.

### 2. GitHub
```bash
git remote add origin https://github.com/barberpulseco/main.git
git push -u origin main
```

### 3. Vercel
1. **Add New → Project** → import the GitHub repo. Framework preset: **Other**. Leave the build settings empty (`vercel.json` handles them).
2. **Environment Variables**: add everything in `.env.example`:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Supabase transaction pooler string |
   | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → API |
   | `SESSION_SECRET` | output of `openssl rand -hex 32` |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `barberpulseco@gmail.com` + a strong password (account is created on first visit) |
   | `SITE_URL` | `https://barberpulse.co` |
   | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | see step 4 |
   | `GOOGLE_MAPS_API_KEY` | optional: better nearby-shop results |
3. Deploy.
4. **Settings → Domains** → add `barberpulse.co` and `www.barberpulse.co`. At the registrar where the domain was bought, set the DNS records Vercel shows (usually an `A` record for `@` pointing to `76.76.21.21` and a `CNAME` for `www` pointing to `cname.vercel-dns.com`).

### 4. Stripe
1. [dashboard.stripe.com](https://dashboard.stripe.com) → Developers → API keys → **Secret key** → `STRIPE_SECRET_KEY`. Start with a `sk_test_` key and switch to `sk_live_` when ready.
2. Developers → Webhooks → **Add endpoint** `https://barberpulse.co/api/stripe/webhook`, event `checkout.session.completed` → copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
3. Redeploy on Vercel so it picks up the new variables.

Without a Stripe key, the Unlock button tells barbers to pay Ethan directly. Ethan then records the cash / e-Transfer payment in Admin, which unlocks the photos just the same.

### 5. Optional: Google Maps
For Google's barbershop data instead of OpenStreetMap: Google Cloud → enable **Places API (New)** → create an API key (restrict it to the Places API) → `GOOGLE_MAPS_API_KEY`. Apple Maps / Google Maps "open in" links work with no key.

---

## Run locally
Needs Node 20+ and Postgres.
```bash
npm install
cp .env.example .env        # set DATABASE_URL to a local Postgres; add DEMO_PAYMENTS=1 to fake payments
npm run db:migrate
npm run seed                # optional demo data (local databases only)
npm run dev                 # http://localhost:3000
```
Without Supabase keys, photos are stored in `./.local-uploads` (local development only).

## Changing prices
Prices live in `lib/packages.js` (used for booking and billing) **and** in the menu in `public/index.html` (the marketing page). Update both.

## Files
```
api/index.js          Vercel serverless entry → lib/app.js
lib/app.js            every API route (auth, onboarding, portal, payments, admin)
lib/db.js             Postgres pool
lib/auth.js           password hashing + signed session cookie, admin bootstrap
lib/storage.js        Supabase Storage signed upload/view URLs
lib/stripe.js         Stripe Checkout + webhook verification
lib/packages.js       pricing
supabase/schema.sql   database schema (RLS on, no public access)
public/               landing, signup, login, portal, admin (vanilla HTML/CSS/JS)
```
