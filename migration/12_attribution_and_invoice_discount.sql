-- 1. redemption_orders.event_id ----------------------------------------------
-- Lets the new "Attribute orders to events" tool record per-event attribution
-- without touching the ledger. We backfill from the ledger linkages we already
-- have so existing event detail pages keep working.

alter table redemption_orders
  add column if not exists event_id uuid references events(id) on delete set null;

create index if not exists redemption_orders_event_idx
  on redemption_orders (event_id);

-- Backfill event_id for existing rows where we can derive it via ledger.
update redemption_orders ro
set event_id = sub.event_id
from (
  select distinct on (l.shopify_order_id, l.customer_id)
    l.shopify_order_id,
    l.customer_id,
    g.event_id
  from ledger l
  join grants g on g.id = l.grant_id
  where l.type = 'redeem'
    and l.grant_id is not null
    and l.shopify_order_id is not null
  order by l.shopify_order_id, l.customer_id, l.created_at asc
) sub
where ro.event_id is null
  and ro.shopify_order_id = sub.shopify_order_id
  and ro.customer_id      = sub.customer_id;

-- 2. invoices.invoice_discount_pct -------------------------------------------
-- Whole-invoice discount (separate from per-line discounts). Stored as a
-- percentage 0–100. Total = subtotal_after_line_discounts * (1 - this/100).

alter table invoices
  add column if not exists invoice_discount_pct numeric(5, 2) not null default 0;

notify pgrst, 'reload schema';
