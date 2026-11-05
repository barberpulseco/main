-- Barber Pulse schema. Paste into Supabase → SQL Editor → Run (safe to re-run),
-- or run `npm run db:migrate` with DATABASE_URL set.
--
-- All access goes through the Vercel server using the database connection string,
-- so Row Level Security is switched ON with no policies: the public anon key and
-- the auto-generated REST API can read nothing.

create table if not exists shops (
  id          bigserial primary key,
  name        text not null,
  address     text,
  lat         double precision,
  lng         double precision,
  place_id    text,
  source      text not null default 'manual',
  created_at  timestamptz not null default now()
);
create unique index if not exists shops_place_id_key on shops (place_id) where place_id is not null;

create table if not exists users (
  id             bigserial primary key,
  role           text not null default 'barber' check (role in ('barber','admin')),
  name           text not null,
  email          text not null,
  phone          text,
  instagram      text,
  password_hash  text not null,
  shop_id        bigint references shops(id) on delete set null,
  onboarded      boolean not null default false,
  created_at     timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists shoots (
  id             bigserial primary key,
  barber_id      bigint not null references users(id) on delete cascade,
  shop_id        bigint references shops(id) on delete set null,
  package_key    text not null,
  package_name   text not null,
  addons         jsonb not null default '[]',
  price_cents    integer not null default 0 check (price_cents >= 0),
  status         text not null default 'requested'
                 check (status in ('requested','scheduled','completed','delivered','cancelled')),
  scheduled_at   timestamptz,
  completed_at   timestamptz,
  notes          text,
  admin_notes    text,
  drive_link     text,
  preview_count  integer not null default 3 check (preview_count >= 0),
  created_by     text not null default 'barber',
  created_at     timestamptz not null default now()
);
create index if not exists shoots_barber_idx on shoots (barber_id);
create index if not exists shoots_sched_idx on shoots (scheduled_at);

create table if not exists payments (
  id            bigserial primary key,
  shoot_id      bigint not null references shoots(id) on delete cascade,
  amount_cents  integer not null,
  method        text not null default 'cash',
  reference     text unique,          -- Stripe checkout session id, prevents double-recording
  note          text,
  paid_at       timestamptz not null default now()
);
create index if not exists payments_paid_idx on payments (paid_at);
create index if not exists payments_shoot_idx on payments (shoot_id);

create table if not exists photos (
  id             bigserial primary key,
  shoot_id       bigint not null references shoots(id) on delete cascade,
  storage_path   text not null,
  original_name  text,
  is_preview     boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists photos_shoot_idx on photos (shoot_id);

alter table shops    enable row level security;
alter table users    enable row level security;
alter table shoots   enable row level security;
alter table payments enable row level security;
alter table photos   enable row level security;
