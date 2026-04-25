-- =========================================================================
-- Migration 05 — Add expiration_date column to customers
-- Mirrors Klaviyo's `expiration_date` property (most-recent grant's expiration).
-- =========================================================================

alter table customers add column if not exists expiration_date date;

-- Populate from klaviyo_profiles_staging if available, else from earliest active grant
update customers c
set expiration_date = k.expiration_date
from klaviyo_profiles_staging k
where lower(k.email) = c.email
  and c.expiration_date is null;

-- For customers without staging data, fall back to earliest active grant's expires_on
update customers c
set expiration_date = (
  select min(g.expires_on)
  from grants g
  where g.customer_id = c.id and g.status = 'active'
)
where c.expiration_date is null
  and exists (select 1 from grants g where g.customer_id = c.id and g.status = 'active');

create index if not exists customers_expiration_date_idx on customers (expiration_date);
