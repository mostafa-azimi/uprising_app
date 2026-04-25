-- =========================================================================
-- Klaviyo profiles staging — bulk import from Klaviyo CSV export
--
-- Step 1: run this CREATE TABLE.
-- Step 2: in Klaviyo, export profiles with these custom properties:
--   email, first_name, last_name,
--   loyalty_card_code, loyalty_card_balance, last_reward, expiration_date
-- Step 3: build INSERT statements (or upload via psql \copy) using the
--   columns below.
-- =========================================================================

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
  imported_at            timestamptz default now()
);

create index on klaviyo_profiles_staging (lower(loyalty_card_code));
create index on klaviyo_profiles_staging (lower(right(loyalty_card_code, 4)));

-- Sample insert pattern (replace with real values per row):
-- insert into klaviyo_profiles_staging
--   (email, first_name, last_name, klaviyo_profile_id,
--    loyalty_card_code, loyalty_card_balance, last_reward, expiration_date)
-- values
--   ('mike.azimi@dischub.com', 'Mostafa', 'Azimi', '01HXXX...',
--    'fec7cebc5c20f91e', 36.00, 1.00, '2026-10-26'),
--   ('mmazimi1@gmail.com', 'M', 'Azimi', '01HYYY...',
--    '71f54339862b5c42', 30.00, 1.00, '2026-10-26');
