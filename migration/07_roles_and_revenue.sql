-- =========================================================================
-- Migration 07 — Roles, signup auto-onboarding, event kinds, revenue tracking
-- =========================================================================

-- 1. Add `role` to admin_users -------------------------------------------
alter table admin_users add column if not exists role text not null default 'admin'
  check (role in ('admin', 'viewer', 'none'));

-- Make sure existing rows are admin
update admin_users set role = 'admin' where role is null or role = '';

create index if not exists admin_users_role_idx on admin_users (role);

-- Update is_admin() to require role = 'admin'
create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from admin_users where user_id = auth.uid() and role = 'admin') $$;

-- New helper: is_member() — admin OR viewer (read access)
create or replace function is_member() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from admin_users where user_id = auth.uid() and role in ('admin', 'viewer')) $$;

-- 2. Auto-add new signups as 'viewer' (or 'none' if not @dischub.com) ----
create or replace function on_auth_user_created() returns trigger
  language plpgsql security definer set search_path = public
  as $$
declare
  default_role text;
begin
  if new.email is not null and lower(new.email) like '%@dischub.com' then
    default_role := 'viewer';
  else
    default_role := 'none';
  end if;
  insert into admin_users (user_id, email, role)
  values (new.id, new.email, default_role)
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function on_auth_user_created();

-- 3. Split RLS into read (member) vs write (admin) -----------------------
do $$
declare t text;
begin
  for t in
    select unnest(array['customers', 'events', 'grants', 'ledger', 'sync_log',
                        'reconciliation_findings', 'shopify_gift_cards_staging',
                        'klaviyo_profiles_staging']) as t
  loop
    execute format('drop policy if exists "admins full access on %s" on %s', t, t);
    execute format('drop policy if exists "members read %s" on %s', t, t);
    execute format('drop policy if exists "admins write %s" on %s', t, t);
    execute format('drop policy if exists "admins update %s" on %s', t, t);
    execute format('drop policy if exists "admins delete %s" on %s', t, t);

    execute format('create policy "members read %s" on %s for select to authenticated using (is_member())', t, t);
    execute format('create policy "admins write %s" on %s for insert to authenticated with check (is_admin())', t, t);
    execute format('create policy "admins update %s" on %s for update to authenticated using (is_admin()) with check (is_admin())', t, t);
    execute format('create policy "admins delete %s" on %s for delete to authenticated using (is_admin())', t, t);
  end loop;
end $$;

-- admin_users gets stricter rules — only admins can grant/revoke roles
drop policy if exists "users see own admin row" on admin_users;
drop policy if exists "members read admin_users" on admin_users;
drop policy if exists "admins write admin_users" on admin_users;
drop policy if exists "admins update admin_users" on admin_users;
drop policy if exists "admins delete admin_users" on admin_users;

create policy "members read admin_users" on admin_users
  for select to authenticated using (is_member() or user_id = auth.uid());
create policy "admins write admin_users" on admin_users
  for insert to authenticated with check (is_admin());
create policy "admins update admin_users" on admin_users
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admins delete admin_users" on admin_users
  for delete to authenticated using (is_admin());

-- 4. Add `kind` to events to distinguish upload vs system ---------------
alter table events add column if not exists kind text not null default 'upload'
  check (kind in ('upload', 'system'));

-- Backfill: known system events
update events set kind = 'system'
where name in ('Manual Adjustments', 'Rise Migration')
  and kind = 'upload';

create index if not exists events_kind_idx on events (kind);

-- 5. Track redemption orders for revenue attribution --------------------
create table if not exists redemption_orders (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references customers(id) on delete restrict,
  shopify_order_id    text not null unique,
  order_total         numeric(12,2) not null default 0,
  gift_card_amount    numeric(12,2) not null default 0,
  other_amount        numeric(12,2) not null default 0,  -- cash/credit/shoppay
  raw_transactions    jsonb,                              -- for audit
  created_at          timestamptz not null default now()
);

create index if not exists redemption_orders_customer_idx on redemption_orders (customer_id);
create index if not exists redemption_orders_created_at_idx on redemption_orders (created_at desc);

alter table redemption_orders enable row level security;
create policy "members read redemption_orders" on redemption_orders
  for select to authenticated using (is_member());
create policy "admins write redemption_orders" on redemption_orders
  for insert to authenticated with check (is_admin());
create policy "admins update redemption_orders" on redemption_orders
  for update to authenticated using (is_admin()) with check (is_admin());

-- 6. Reload PostgREST schema cache --------------------------------------
notify pgrst, 'reload schema';
