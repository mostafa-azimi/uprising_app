import Link from 'next/link';
import { ResyncButton } from '@/components/resync-button';

export const dynamic = 'force-dynamic';

export default function KlaviyoConnectionPage() {
  const apiKeySet = !!process.env.KLAVIYO_API_KEY;
  const revision = process.env.KLAVIYO_REVISION ?? '2025-01-15';

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/settings" className="text-sm text-muted hover:text-ink">← Settings</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Klaviyo connection</h1>
      <p className="text-sm text-muted mb-8">Read-only display. To change values, update env vars in Vercel and redeploy.</p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-3">Current config</h2>
        <dl className="text-sm space-y-2">
          <Row label="Private API key" value={apiKeySet ? <Pill ok>set</Pill> : <Pill bad>missing</Pill>} />
          <Row label="API revision" value={<span className="font-mono text-xs">{revision}</span>} />
        </dl>

        <details className="mt-5 text-sm text-muted">
          <summary className="cursor-pointer">How to update</summary>
          <ol className="mt-2 pl-5 list-decimal space-y-1">
            <li>Generate a new key in Klaviyo: Settings → API Keys → Create Private API Key (scopes: profiles:read, profiles:write, events:write, lists:write).</li>
            <li>Update <code>KLAVIYO_API_KEY</code> in Vercel env vars.</li>
            <li>Redeploy. Verify under <Link href="/test-connections" className="text-ink underline">Test connections</Link>.</li>
          </ol>
        </details>
      </section>

      <section className="border border-line rounded-xl bg-white p-6">
        <h2 className="font-semibold mb-3">Push current state to Klaviyo</h2>
        <ResyncButton
          endpoint="/api/admin/resync-klaviyo"
          label="Push to Klaviyo"
          pendingLabel="Pushing…"
          description="For every customer with a loyalty_card_code, push the current loyalty_card_balance, loyalty_card_code, and expiration_date to their Klaviyo profile. Useful if Klaviyo has gotten out of sync."
        />
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-line last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Pill({ children, ok, bad }: { children: React.ReactNode; ok?: boolean; bad?: boolean }) {
  const cls = ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : bad ? 'bg-red-50 text-bad border-bad' : 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${cls}`}>{children}</span>;
}
