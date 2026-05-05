import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function TemporaryToolsPage() {
  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <div className="flex items-baseline gap-3 mt-2 mb-1 flex-wrap">
        <h1 className="text-3xl font-bold">Temporary tools</h1>
        <span className="text-xs text-amber-700 bg-yellow-100 border border-yellow-300 px-2 py-0.5 rounded-full uppercase tracking-wide">Cleanup</span>
      </div>
      <p className="text-sm text-muted mb-2">
        One-time data cleanup utilities for backfilling links between our DB and Shopify.
        These are <strong>not part of the regular operational toolkit</strong> — they exist to
        repair customers that came in through skip-Klaviyo or skip-Shopify uploads.
      </p>
      <p className="text-sm text-muted mb-8">
        Recommended order: <strong>1.</strong> Upload loyalty codes →
        {' '}<strong>2.</strong> Link gift cards by code →
        {' '}<strong>3.</strong> <Link href="/admin/sync-shopify-balances" className="text-ink hover:underline">Sync balances from Shopify</Link> (permanent).
        Once your data is clean, you can stop visiting this page.
      </p>

      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card
          href="/admin/upload-loyalty-codes"
          title="Upload loyalty codes"
          desc="Bulk-update customers.loyalty_card_code from a CSV with email,loyalty_card_code columns. No Shopify writes."
          stepNumber={1}
        />
        <Card
          href="/admin/link-by-code"
          title="Link gift cards by code"
          desc="For customers with loyalty_card_code set but shopify_gift_card_id NULL, match by last-4 against Shopify and link the unique matches. No Shopify writes."
          stepNumber={2}
        />
      </section>

      <h2 className="text-lg font-semibold mb-3">After cleanup</h2>
      <p className="text-sm text-muted mb-4">
        Run the permanent reconcile tool to surface and fix any balance deltas between
        our DB and Shopify. That tool is what you&apos;ll use ongoing.
      </p>
      <section className="grid sm:grid-cols-2 gap-4">
        <Card
          href="/admin/sync-shopify-balances"
          title="Sync balances from Shopify (permanent)"
          desc="Pull Shopify balances, compare with DB, apply discrepancies via FIFO debit + Shopify sync reconciliation ledger entries."
        />
      </section>
    </main>
  );
}

function Card({ href, title, desc, stepNumber }: { href: string; title: string; desc: string; stepNumber?: number }) {
  return (
    <Link href={href} className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
      <div className="flex items-start gap-3">
        {stepNumber !== undefined && (
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-xs font-bold text-muted shrink-0">
            {stepNumber}
          </span>
        )}
        <div>
          <h3 className="font-semibold mb-1">{title}</h3>
          <p className="text-sm text-muted">{desc}</p>
        </div>
      </div>
    </Link>
  );
}
