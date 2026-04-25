# Uprising

Self-hosted replacement for Rise.ai. Bulk-issues store credit to customers, mirrors balances to a per-customer Shopify gift card, and syncs the four Rise-compatible profile properties (`loyalty_card_code`, `loyalty_card_balance`, `last_reward`, `expiration_date`) to Klaviyo.

## Stack

- Next.js 14 (App Router) on Vercel
- Supabase Postgres (data + auth via magic link)
- Shopify Admin GraphQL (gift card create/credit/debit)
- Klaviyo REST (profile upsert + property updates)

## Project structure

```
app/
  api/test-connections/route.ts   API: pings Supabase + Shopify + Klaviyo
  auth/callback/route.ts          Handles Supabase magic-link redirect
  dashboard/page.tsx              Authenticated landing page
  login/                          Magic-link sign-in page + server actions
  test-connections/page.tsx       Foundation health check UI
  layout.tsx, globals.css, page.tsx
lib/
  shopify.ts                      Typed Admin GraphQL wrapper
  klaviyo.ts                      Typed REST wrapper
  supabase/                       Server, browser, middleware clients
  types.ts                        Shared types
supabase/
  migrations/0001_initial_schema.sql   Tables, indexes, RLS policies
middleware.ts                     Auth gate at the edge
```

## Setup

See `SETUP.md` for the full step-by-step deployment guide.

## Development

```bash
npm install
cp .env.example .env.local
# fill in .env.local
npm run dev
```

## What's implemented (Phase 1 — foundation)

- ✅ Auth (Supabase magic link)
- ✅ Admin gate via `admin_users` table + RLS
- ✅ Database schema (customers, events, grants, ledger, sync_log, reconciliation_findings)
- ✅ Shopify and Klaviyo typed clients
- ✅ `/test-connections` health check page

## What's coming (Phase 2+)

- File 2 upload UI + bulk grant processing
- Customer detail page with grant editing
- Daily expiration cron job (Vercel Cron)
- Shopify `orders/paid` webhook for FIFO redemption
- Reconciliation dashboard
- Exports
