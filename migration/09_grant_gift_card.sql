-- =========================================================================
-- Migration 09 — Per-grant gift card link
--
-- Rise creates a NEW Shopify gift card for every credit issuance, so a single
-- customer can have many cards. Move shopify_gift_card_id off `customers` and
-- onto `grants` so each grant tracks its own card. customers.shopify_gift_card_id
-- stays as a denormalized "primary card" pointer for display.
-- =========================================================================

alter table grants add column if not exists shopify_gift_card_id text;
alter table grants add column if not exists shopify_gift_card_code text;
alter table grants add column if not exists shopify_gift_card_last4 text;
alter table grants add column if not exists initial_balance numeric(12,2);

create index if not exists grants_shopify_gift_card_id_idx on grants (shopify_gift_card_id);
create index if not exists grants_shopify_gift_card_code_idx on grants (shopify_gift_card_code);

notify pgrst, 'reload schema';
