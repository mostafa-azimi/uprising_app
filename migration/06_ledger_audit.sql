-- =========================================================================
-- Migration 06 — Add audit trail to ledger
-- Tracks which admin user (if any) triggered each balance-changing event.
-- Null for automated changes (webhook redemptions, scheduled expirations).
-- =========================================================================

alter table ledger add column if not exists created_by uuid references auth.users(id);
alter table ledger add column if not exists created_by_email text;

create index if not exists ledger_created_by_idx on ledger (created_by);
create index if not exists ledger_type_created_at_idx on ledger (type, created_at desc);

notify pgrst, 'reload schema';
