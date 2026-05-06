import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function ToolsPage() {
  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold mb-1">Tools</h1>
      <p className="text-sm text-muted mb-8">
        Admin utilities for ongoing data sync and reconciliation tasks.
      </p>

      <h2 className="text-lg font-semibold mb-3">Reconciliation & sync</h2>
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card
          href="/admin/sync-shopify-balances"
          title="Sync balances from Shopify"
          desc="Real-time compare DB balances vs Shopify gift card balances. Section A (DB > Shopify): bulk-fix DB. Section B (Shopify > DB): per-row choose Fix Shopify or Fix DB."
        />
        <Card
          href="/admin/backfill-redemptions"
          title="Backfill redemptions"
          desc="Pull paid Shopify orders in a date range and process gift_card transactions through the same logic as the orders/paid webhook. Updates balances + revenue attribution."
        />
        <Card
          href="/admin/attribute-orders"
          title="Attribute orders to events"
          desc="Read-only for loyalty: maps recent paid Shopify orders to events for revenue attribution. Does NOT touch ledger, gift card balances, Klaviyo, or Shopify."
        />
        <Card
          href="/test-connections"
          title="Test connections"
          desc="Verify Supabase, Shopify, and Klaviyo are reachable from this deployment."
        />
      </section>

      <h2 className="text-lg font-semibold mb-3">Klaviyo</h2>
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card
          href="/admin/klaviyo-failures"
          title="Klaviyo failures"
          desc="Customers whose Klaviyo push retried 3 times and still failed. Per-row Retry now or one-click Retry all to flush the entire backlog."
        />
        <Card
          href="/admin/push-to-klaviyo"
          title="Push to Klaviyo (catch-up)"
          desc="Re-push current DB state (loyalty_card_code, balance, expiration) to Klaviyo for every customer with a balance change in a date range. Use this after Klaviyo outages."
        />
      </section>
    </main>
  );
}

function Card({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted">{desc}</p>
    </Link>
  );
}
