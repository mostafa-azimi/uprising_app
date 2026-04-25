-- =========================================================================
-- Migration 0003 — Switch back to orphan Shopify Gift Cards
-- After live verification, Rise.ai actually uses orphan Shopify Gift Cards
-- (with the gift card code = loyalty_card_code), NOT Store Credit Accounts.
-- The "Store Credit" label in Rise's admin is just their UI naming.
--
-- Reversing migration 0002.
-- =========================================================================

alter table customers rename column shopify_store_credit_account_id to shopify_gift_card_id;
alter table customers add column if not exists shopify_gift_card_last4 text;

drop index if exists customers_store_credit_account_idx;
create index if not exists customers_gift_card_id_idx
  on customers (shopify_gift_card_id);

-- loyalty_card_code stays as a column. From now on it equals the Shopify
-- gift card code (returned at giftCardCreate time, immutable thereafter).
