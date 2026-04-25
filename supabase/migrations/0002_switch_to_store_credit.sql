-- =========================================================================
-- Migration 0002 — Switch from Gift Cards to Store Credit Accounts
-- Rise.ai actually uses Shopify Store Credit Accounts (reloadable credit
-- per customer with native per-transaction expiration), not Gift Cards.
-- =========================================================================

-- Rename columns to reflect the new model
alter table customers rename column shopify_gift_card_id to shopify_store_credit_account_id;
alter table customers rename column shopify_gift_card_code to loyalty_card_code;
alter table customers drop column if exists shopify_gift_card_last4;

-- Update sync_log entries (cosmetic, optional)
-- (no action needed — sync_log values are free-form text)

-- Rebuild indexes
drop index if exists customers_shopify_gift_card_id_idx;
create index if not exists customers_store_credit_account_idx
  on customers (shopify_store_credit_account_id);
create index if not exists customers_loyalty_card_code_idx
  on customers (loyalty_card_code);
