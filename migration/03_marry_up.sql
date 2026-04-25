-- =========================================================================
-- Migration 03 — Marry Klaviyo + Shopify staging into the live customers table
--
-- Run AFTER:
--   01_shopify_gift_cards_staging.sql  (loaded with Shopify export)
--   02_klaviyo_profiles_staging.sql    (loaded with Klaviyo export)
--
-- This is idempotent — safe to re-run.
-- =========================================================================

-- ----- Step 1: ensure a "Rise Migration" event exists ---------------------
do $$
declare
  migration_event_id uuid;
begin
  select id into migration_event_id
  from events
  where name = 'Rise Migration'
  order by created_at desc
  limit 1;

  if migration_event_id is null then
    insert into events (name, host, source_filename, status)
    values ('Rise Migration', 'Migration', 'klaviyo_export + shopify_export', 'completed')
    returning id into migration_event_id;
  end if;
end $$;

-- ----- Step 2: upsert customers from Klaviyo staging ----------------------
-- Loyalty code, name, klaviyo profile ID all come from Klaviyo.
insert into customers (
  email, first_name, last_name,
  klaviyo_profile_id, loyalty_card_code, total_balance_cached
)
select
  lower(trim(email)),
  first_name,
  last_name,
  klaviyo_profile_id,
  loyalty_card_code,
  coalesce(loyalty_card_balance, 0)
from klaviyo_profiles_staging
where email is not null and trim(email) <> ''
on conflict (email) do update set
  first_name           = coalesce(excluded.first_name, customers.first_name),
  last_name            = coalesce(excluded.last_name, customers.last_name),
  klaviyo_profile_id   = coalesce(excluded.klaviyo_profile_id, customers.klaviyo_profile_id),
  loyalty_card_code    = coalesce(excluded.loyalty_card_code, customers.loyalty_card_code),
  total_balance_cached = excluded.total_balance_cached;

-- ----- Step 3: link shopify_gift_card_id by matching last 4 of code -------
-- For each customer with loyalty_card_code but no shopify_gift_card_id,
-- find the Shopify gift card with matching last 4 (and prefer enabled cards).
update customers c
set
  shopify_gift_card_id    = 'gid://shopify/GiftCard/' || g.id::text,
  shopify_gift_card_last4 = g.last_characters
from (
  select distinct on (last_characters)
    id, last_characters, current_balance, enabled
  from shopify_gift_cards_staging
  where enabled = true
  order by last_characters, current_balance desc
) g
where c.loyalty_card_code is not null
  and c.shopify_gift_card_id is null
  and lower(right(c.loyalty_card_code, 4)) = lower(g.last_characters);

-- ----- Step 4: report stats ----------------------------------------------
select
  (select count(*) from klaviyo_profiles_staging) as klaviyo_rows,
  (select count(*) from shopify_gift_cards_staging where enabled = true) as shopify_enabled_cards,
  (select count(*) from customers) as customers_total,
  (select count(*) from customers where loyalty_card_code is not null) as customers_with_code,
  (select count(*) from customers where shopify_gift_card_id is not null) as customers_with_card_id,
  (select count(*) from customers
   where loyalty_card_code is not null and shopify_gift_card_id is null) as unlinked_customers;

-- ----- Optional Step 5: create synthetic grants for current balances ------
-- Only run this when you're ready to take ownership of the existing balances.
-- It creates one "Migrated" grant per customer with their current balance and
-- the expiration_date pulled from Klaviyo. Skipped if current balance is 0.
--
-- IMPORTANT: only run if you're cutting over Rise. If Rise is still managing
-- expirations on the same gift cards, skip this step or expirations will be
-- double-counted.

-- do $$
-- declare
--   migration_event_id uuid;
-- begin
--   select id into migration_event_id from events where name = 'Rise Migration' limit 1;
--
--   insert into grants (customer_id, event_id, initial_amount, remaining_amount, expires_on, reason, note, status)
--   select
--     c.id,
--     migration_event_id,
--     k.loyalty_card_balance,
--     k.loyalty_card_balance,
--     coalesce(k.expiration_date, current_date + interval '6 months'),
--     'Migrated',
--     'Initial balance carried over from Rise on ' || current_date,
--     'active'
--   from customers c
--   join klaviyo_profiles_staging k on lower(k.email) = c.email
--   where coalesce(k.loyalty_card_balance, 0) > 0
--     and not exists (
--       select 1 from grants g where g.customer_id = c.id and g.note like 'Initial balance carried over from Rise%'
--     );
--
--   insert into ledger (customer_id, grant_id, type, amount, description)
--   select
--     g.customer_id, g.id, 'issue', g.initial_amount,
--     'Migrated initial balance from Rise'
--   from grants g
--   where g.note like 'Initial balance carried over from Rise%';
-- end $$;
