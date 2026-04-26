import Link from 'next/link';
import { ResyncButton } from '@/components/resync-button';

export const dynamic = 'force-dynamic';

export default function ShopifyConnectionPage() {
  const store = process.env.SHOPIFY_STORE_DOMAIN ?? '(not set)';
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? '2025-10';
  const tokenSet = !!process.env.SHOPIFY_ADMIN_TOKEN;
  const webhookSecretSet = !!process.env.SHOPIFY_WEBHOOK_SECRET;

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/settings" className="text-sm text-muted hover:text-ink">← Settings</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Shopify connection</h1>
      <p className="text-sm text-muted mb-8">Read-only display of your Shopify Admin API config. To change values, update env vars in Vercel and redeploy.</p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-3">Current config</h2>
        <dl className="text-sm space-y-2">
          <Row label="Store domain" value={store} />
          <Row label="API version" value={apiVersion} />
          <Row label="Admin API token" value={tokenSet ? <Pill ok>set</Pill> : <Pill bad>missing</Pill>} mono={false} />
          <Row label="Webhook signing secret" value={webhookSecretSet ? <Pill ok>set</Pill> : <Pill bad>missing</Pill>} mono={false} />
        </dl>

        <details className="mt-5 text-sm text-muted">
          <summary className="cursor-pointer">How to update these values</summary>
          <ol className="mt-2 pl-5 list-decimal space-y-1">
            <li>Open Vercel → your project → Settings → Environment Variables.</li>
            <li>Update <code>SHOPIFY_STORE_DOMAIN</code>, <code>SHOPIFY_ADMIN_TOKEN</code>, <code>SHOPIFY_API_VERSION</code>, or <code>SHOPIFY_WEBHOOK_SECRET</code>.</li>
            <li>Trigger a redeploy (Deployments → latest → Redeploy).</li>
            <li>Verify under <Link href="/test-connections" className="text-ink underline">Test connections</Link>.</li>
          </ol>
        </details>
      </section>

      <section className="border border-line rounded-xl bg-white p-6">
        <h2 className="font-semibold mb-3">Resync from Shopify</h2>
        <ResyncButton
          endpoint="/api/admin/resync-shopify"
          label="Resync gift card balances"
          pendingLabel="Pulling balances…"
          description="Fetches the current gift card balance from Shopify for every linked customer and corrects any drift in our database (treating Shopify as the source of truth). Drift gets logged to the ledger and reconciliation_findings. Klaviyo is also updated."
        />
      </section>
    </main>
  );
}

function Row({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-line last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
  );
}

function Pill({ children, ok, bad }: { children: React.ReactNode; ok?: boolean; bad?: boolean }) {
  const cls = ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : bad ? 'bg-red-50 text-bad border-bad' : 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${cls}`}>{children}</span>;
}
