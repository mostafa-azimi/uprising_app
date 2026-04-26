-- =========================================================================
-- Migration 08 — Separate change_log for non-balance audit events
--
-- Ledger stays focused on money: issue / redeem / expire / adjust (with $).
-- change_log captures everything else: email changes, code changes,
-- expiration_date display changes, etc.
-- =========================================================================

create table if not exists change_log (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references customers(id) on delete cascade,
  field              text not null,
  old_value          text,
  new_value          text,
  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),
  created_by_email   text
);

create index if not exists change_log_customer_idx on change_log (customer_id, created_at desc);
create index if not exists change_log_field_idx on change_log (field);
create index if not exists change_log_created_at_idx on change_log (created_at desc);

alter table change_log enable row level security;

create policy "members read change_log" on change_log
  for select to authenticated using (is_member());
create policy "admins write change_log" on change_log
  for insert to authenticated with check (is_admin());

-- Migrate any existing $0 'adjust' rows that were created by the previous
-- profile-update flow into change_log, then remove them from ledger so the
-- ledger only contains balance-impacting events.
insert into change_log (customer_id, field, old_value, new_value, created_at, created_by, created_by_email)
select
  customer_id,
  'profile_update_legacy' as field,
  null as old_value,
  description as new_value,
  created_at,
  created_by,
  created_by_email
from ledger
where type = 'adjust' and amount = 0 and description like 'Profile fields updated:%';

delete from ledger
where type = 'adjust' and amount = 0 and description like 'Profile fields updated:%';

notify pgrst, 'reload schema';
