-- =========================================================================
-- Uprising App — Initial Schema
-- Rise.ai replacement: Shopify gift card credits, Klaviyo profile sync
-- =========================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- -------------------------------------------------------------------------
-- admin_users — gates RLS access. Insert your email here after sign-up.
-- -------------------------------------------------------------------------
create table if not exists admin_users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  created_at  timestamptz not null default now()
);

-- helper: returns true if the current authenticated user is an admin
create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from admin_users where user_id = auth.uid()) $$;

-- -------------------------------------------------------------------------
-- customers — one row per customer email
-- -------------------------------------------------------------------------
create table if not exists customers (
  id                          uuid primary key default gen_random_uuid(),
  email                       text not null unique,
  first_name                  text,
  last_name                   text,
  shopify_customer_id         text,
  shopify_gift_card_id        text,
  shopify_gift_card_code      text,           -- full code (returned ONCE at creation, store securely)
  shopify_gift_card_last4     text,
  klaviyo_profile_id          text,
  total_balance_cached        numeric(12,2) not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists customers_email_lower_idx on customers (lower(email));
create index if not exists customers_shopify_gift_card_id_idx on customers (shopify_gift_card_id);

-- -------------------------------------------------------------------------
-- events — one row per CSV upload campaign
-- e.g. "NADGT - CO Premier | Payout"
-- -------------------------------------------------------------------------
create table if not exists events (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  host                text,
  event_date          date,
  uploaded_by         uuid references auth.users(id),
  source_filename     text,
  total_grants_count  integer not null default 0,
  total_grants_amount numeric(12,2) not null default 0,
  status              text not null default 'completed',  -- 'completed' | 'failed' | 'partial'
  notes               text,
  created_at          timestamptz not null default now()
);
create index if not exists events_event_date_idx on events (event_date desc);
create index if not exists events_name_idx on events (name);

-- -------------------------------------------------------------------------
-- grants — every credit issuance. Immutable except for remaining_amount/status.
-- -------------------------------------------------------------------------
create table if not exists grants (
  id                              uuid primary key default gen_random_uuid(),
  customer_id                     uuid not null references customers(id) on delete restrict,
  event_id                        uuid not null references events(id) on delete restrict,
  initial_amount                  numeric(12,2) not null check (initial_amount >= 0),
  remaining_amount                numeric(12,2) not null check (remaining_amount >= 0),
  expires_on                      date not null,
  reason                          text,
  note                            text,
  status                          text not null default 'active',  -- 'active' | 'expired' | 'fully_redeemed'
  expired_at                      timestamptz,
  expiration_warning_sent_at      timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);
create index if not exists grants_customer_status_expires_idx
  on grants (customer_id, status, expires_on);
create index if not exists grants_active_expires_idx
  on grants (status, expires_on) where status = 'active';
create index if not exists grants_event_idx on grants (event_id);

-- -------------------------------------------------------------------------
-- ledger — append-only log of every balance change. Never UPDATE/DELETE.
-- -------------------------------------------------------------------------
create table if not exists ledger (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             uuid not null references customers(id) on delete restrict,
  grant_id                uuid references grants(id) on delete set null,
  type                    text not null,  -- 'issue' | 'redeem' | 'expire' | 'adjust'
  amount                  numeric(12,2) not null,  -- +ve for issue, -ve for redeem/expire
  shopify_transaction_id  text,
  shopify_order_id        text,
  description             text,
  created_at              timestamptz not null default now()
);
create index if not exists ledger_customer_created_idx on ledger (customer_id, created_at desc);
create index if not exists ledger_grant_idx on ledger (grant_id);
create index if not exists ledger_order_idx on ledger (shopify_order_id) where shopify_order_id is not null;

-- -------------------------------------------------------------------------
-- sync_log — diagnostic trail of every external API call
-- -------------------------------------------------------------------------
create table if not exists sync_log (
  id              uuid primary key default gen_random_uuid(),
  target          text not null,            -- 'shopify' | 'klaviyo'
  operation       text not null,
  entity_id       text,
  request_body    jsonb,
  response_body   jsonb,
  status_code     integer,
  ok              boolean not null,
  error_message   text,
  created_at      timestamptz not null default now()
);
create index if not exists sync_log_target_ok_created_idx
  on sync_log (target, ok, created_at desc);

-- -------------------------------------------------------------------------
-- reconciliation_findings — daily drift detection
-- -------------------------------------------------------------------------
create table if not exists reconciliation_findings (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references customers(id),
  computed_balance    numeric(12,2) not null,
  shopify_balance     numeric(12,2) not null,
  delta               numeric(12,2) not null,
  resolved            boolean not null default false,
  resolution_note     text,
  created_at          timestamptz not null default now()
);
create index if not exists reconciliation_unresolved_idx
  on reconciliation_findings (resolved, created_at desc) where resolved = false;

-- -------------------------------------------------------------------------
-- updated_at trigger
-- -------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at before update on customers
  for each row execute function set_updated_at();

drop trigger if exists grants_set_updated_at on grants;
create trigger grants_set_updated_at before update on grants
  for each row execute function set_updated_at();

-- =========================================================================
-- Row Level Security: admin-only access via admin_users membership
-- =========================================================================
alter table customers                 enable row level security;
alter table events                    enable row level security;
alter table grants                    enable row level security;
alter table ledger                    enable row level security;
alter table sync_log                  enable row level security;
alter table reconciliation_findings   enable row level security;
alter table admin_users               enable row level security;

-- Admins can read/write everything
create policy "admins full access on customers"  on customers
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on events"    on events
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on grants"    on grants
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on ledger"    on ledger
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on sync_log"  on sync_log
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on findings"  on reconciliation_findings
  for all to authenticated using (is_admin()) with check (is_admin());

-- Authenticated users can see their own admin_users row (needed for is_admin())
create policy "users see own admin row" on admin_users
  for select to authenticated using (user_id = auth.uid());

-- =========================================================================
-- Seed: insert your admin email here AFTER first sign-in via magic link
-- The auth.users row will exist after Supabase sends the magic link.
-- Replace the email below with yours, then run:
--
--   insert into admin_users (user_id, email)
--   select id, email from auth.users where email = 'mike.azimi@shiphero.com'
--   on conflict (user_id) do nothing;
-- =========================================================================
