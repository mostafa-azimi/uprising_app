import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function ToolsPage() {
  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold mb-1">Tools</h1>
      <p className="text-sm text-muted mb-8">
        Admin utilities for one-off imports, backfills, and data sync. Use these for migration
        and reconciliation tasks — not for everyday operations.
      </p>

      <h2 className="text-lg font-semibold mb-3">Imports & backfills</h2>
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card
          href="/admin/import-master"
          title="Import Master Rise file"
          desc="One-shot CSV importer for the Rise master export. Creates customers + grants from every row."
        />
        <Card
          href="/admin/link-gift-cards"
          title="Link gift cards from Master Rise file"
          desc="Backfill missing shopify_gift_card_id / loyalty_card_code on existing customers. DB only — no Shopify calls."
        />
      </section>

      <h2 className="text-lg font-semibold mb-3">Reconciliation & sync</h2>
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card
          href="/admin/reconcile-shopify"
          title="Reconcile from Shopify"
          desc="Upload a fresh Shopify gift cards export to bring our DB in sync with Shopify's current balances."
        />
        <Card
          href="/admin/backfill-redemptions"
          title="Backfill redemptions"
          desc="Pull paid Shopify orders in a date range and process gift_card transactions through the same logic as the orders/paid webhook. Updates balances + revenue attribution."
        />
        <Card
          href="/test-connections"
          title="Test connections"
          desc="Verify Supabase, Shopify, and Klaviyo are reachable from this deployment."
        />
      </section>

      <h2 className="text-lg font-semibold mb-3">Upload</h2>
      <section className="grid sm:grid-cols-2 gap-4">
        <Card
          href="/upload/grants"
          title="Upload event credits"
          desc="Standard upload flow with optional Skip Shopify / Skip Klaviyo toggles for DB-only backfills."
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
