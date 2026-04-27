-- =========================================================================
-- Migration 10 — App settings table
-- Simple key/value store for app-level toggles like auto_expire_enabled.
-- =========================================================================

create table if not exists app_settings (
  key                 text primary key,
  value               jsonb not null default '{}'::jsonb,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id),
  updated_by_email    text
);

alter table app_settings enable row level security;

drop policy if exists "members read app_settings" on app_settings;
drop policy if exists "admins write app_settings" on app_settings;
drop policy if exists "admins update app_settings" on app_settings;

create policy "members read app_settings" on app_settings
  for select to authenticated using (is_member());
create policy "admins write app_settings" on app_settings
  for insert to authenticated with check (is_admin());
create policy "admins update app_settings" on app_settings
  for update to authenticated using (is_admin()) with check (is_admin());

-- Default: auto-expire DISABLED until you turn it on
insert into app_settings (key, value)
values ('auto_expire_enabled', 'false'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
