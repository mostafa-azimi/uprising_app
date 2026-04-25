-- =========================================================================
-- One-time setup: create the two staging tables.
-- Small + safe to paste into Supabase SQL Editor.
-- After running this, use /admin/migrate to upload the actual CSV data.
-- =========================================================================

-- Shopify gift cards staging
drop table if exists shopify_gift_cards_staging;
create table shopify_gift_cards_staging (
  id                bigint primary key,
  last_characters   text,
  customer_name     text,
  email             text,
  date_issued       timestamptz,
  expires_on        date,
  initial_balance   numeric(12,2),
  current_balance   numeric(12,2),
  enabled           boolean,
  expired           boolean,
  note              text
);
create index on shopify_gift_cards_staging (last_characters);
create index on shopify_gift_cards_staging (enabled, current_balance) where enabled = true;

-- Klaviyo profiles staging
drop table if exists klaviyo_profiles_staging;
create table klaviyo_profiles_staging (
  email                  text primary key,
  first_name             text,
  last_name              text,
  klaviyo_profile_id     text,
  loyalty_card_code      text,
  loyalty_card_balance   numeric(12,2),
  last_reward            numeric(12,2),
  expiration_date        date,
  last_event_date        timestamptz,
  imported_at            timestamptz default now()
);
create index on klaviyo_profiles_staging (lower(loyalty_card_code));
create index on klaviyo_profiles_staging (lower(right(loyalty_card_code, 4)));

-- Both staging tables get RLS like the others
alter table shopify_gift_cards_staging enable row level security;
alter table klaviyo_profiles_staging enable row level security;

create policy "admins full access on shopify_gift_cards_staging" on shopify_gift_cards_staging
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on klaviyo_profiles_staging" on klaviyo_profiles_staging
  for all to authenticated using (is_admin()) with check (is_admin());
