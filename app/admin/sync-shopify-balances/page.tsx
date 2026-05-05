'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

interface DiscrepancyRow {
  customer_id: string;
  email: string;
  shopify_gift_card_id: string;
  last4: string | null;
  shopify_balance: number;
  shopify_enabled: boolean;
  db_total_remaining: number;
  diff: number;
  affected_grant_ids: string[];
  expires_on_earliest: string | null;
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  shopify_cards_total: number;
  grants_with_card_id: number;
  customers_with_card: number;
  in_sync_count: number;
  discrepancy_count: number;
  total_db_to_subtract: number;
  total_db_to_add: number;
  unmatched_shopify_card_ids_sample: string[];
  duration_ms: number;
  rows: DiscrepancyRow[];
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  shopify_gift_card_id: string;
  status: 'applied' | 'in_sync' | 'stale' | 'error';
  prior_db_total: number;
  new_db_total: number;
  delta_applied: number;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  rows_applied: number;
  rows_in_sync: number;
  rows_stale: number;
  rows_errored: number;
  total_delta_applied: number;
  customers_recomputed: number;
  klaviyo_pushed: number;
  klaviyo_errors: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

export default function SyncShopifyBalancesPage() {
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function runPreview() {
    setPreviewBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await fetch('/api/admin/sync-shopify-balances/preview', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        setPreview(null);
        return;
      }
      setPreview(json as PreviewResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function runApply() {
    if (!preview) return;
    setApplyBusy(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const res = await fetch('/api/admin/sync-shopify-balances/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: preview.rows.map((r) => ({
            customer_id: r.customer_id,
            email: r.email,
            shopify_gift_card_id: r.shopify_gift_card_id,
            shopify_balance: r.shopify_balance,
            db_total_remaining: r.db_total_remaining,
            diff: r.diff,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setApplyResult(json as ApplyResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyBusy(false);
    }
  }

  const totalAbsDiff = useMemo(() => {
    if (!preview) return 0;
    return preview.rows.reduce((s, r) => s + Math.abs(r.diff), 0);
  }, [preview]);

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Sync gift card balances from Shopify</h1>
      <p className="text-sm text-muted mb-2">
        Pull every gift card balance directly from Shopify, compare with our DB, and reconcile any drift.
        This is a <strong>two-step</strong> process: preview shows discrepancies (read-only), then you click Apply to commit.
      </p>
      <p className="text-xs text-muted mb-6">
        On apply, Shopify becomes the source of truth: each grant&apos;s remaining_amount is adjusted so the customer&apos;s
        DB total for that gift card matches Shopify. Each touched grant gets a <code>type=adjust</code> ledger entry
        with description &quot;Shopify sync reconciliation — set to $X (was $Y)&quot;. When the diff is negative (DB &gt; Shopify),
        we debit the oldest-expiring grant first (FIFO). When positive, we credit the newest grant (longest expiration).
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-2">Step 1 — Preview</h2>
        <p className="text-sm text-muted mb-4">
          Pulls all gift cards from Shopify, sums each customer&apos;s grants per card, and shows any discrepancies. No DB writes.
        </p>
        <button
          onClick={runPreview}
          disabled={previewBusy || applyBusy}
          className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {previewBusy ? 'Pulling from Shopify…' : 'Run preview'}
        </button>
        {previewBusy && (
          <p className="text-xs text-muted mt-2">
            Pages through Shopify gift cards and grants in our DB. Can take 30–60s for ~6500 cards.
          </p>
        )}
      </section>

      {error && (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {preview && (
        <>
          <section className="border border-line rounded-xl bg-white p-6 mb-6">
            <h2 className="font-bold mb-3">Preview snapshot</h2>
            <p className="text-xs text-muted mb-3">Generated at {new Date(preview.generated_at).toLocaleString()}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Row label="Shopify cards total" value={preview.shopify_cards_total.toLocaleString()} />
              <Row label="Customers with a linked card" value={preview.customers_with_card.toLocaleString()} />
              <Row label="Customer–card pairs in sync" value={preview.in_sync_count.toLocaleString()} />
              <Row label="Discrepancies" value={preview.discrepancy_count.toLocaleString()} bold={preview.discrepancy_count > 0} />
              <Row label="DB will DECREASE by" value={`$${Math.abs(preview.total_db_to_subtract).toFixed(2)}`} />
              <Row label="DB will INCREASE by" value={`$${preview.total_db_to_add.toFixed(2)}`} />
              <Row label="Net DB change" value={`$${(preview.total_db_to_add + preview.total_db_to_subtract).toFixed(2)}`} bold />
            </dl>
          </section>

          {preview.discrepancy_count === 0 ? (
            <div className="p-6 rounded-xl border border-emerald-200 bg-emerald-50 text-sm">
              <strong className="text-emerald-800">All in sync.</strong> Every customer&apos;s DB total matches Shopify&apos;s current balance for their gift card. Nothing to apply.
            </div>
          ) : (
            <>
              <section className="border border-line rounded-xl bg-white p-0 mb-6 overflow-hidden">
                <div className="px-6 py-4 border-b border-line">
                  <h2 className="font-bold">Discrepancies ({preview.discrepancy_count})</h2>
                  <p className="text-xs text-muted">
                    Sorted by absolute diff descending. Sum of absolute diffs: ${totalAbsDiff.toFixed(2)}.
                    Negative diff = DB had more than Shopify (will debit on apply).
                  </p>
                </div>
                <div className="overflow-auto max-h-[600px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 border-b border-line">
                      <tr className="text-left text-muted">
                        <th className="py-2 px-4 font-medium">Customer</th>
                        <th className="py-2 px-4 font-medium">Card last4</th>
                        <th className="py-2 px-4 font-medium text-right">DB has</th>
                        <th className="py-2 px-4 font-medium text-right">Shopify says</th>
                        <th className="py-2 px-4 font-medium text-right">Diff</th>
                        <th className="py-2 px-4 font-medium text-right">Grants touched</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, i) => (
                        <tr key={i} className="border-b border-line last:border-0">
                          <td className="py-1.5 px-4">
                            <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline text-xs">{r.email}</Link>
                            {!r.shopify_enabled && <span className="ml-2 text-xs text-muted">(disabled)</span>}
                          </td>
                          <td className="py-1.5 px-4 font-mono text-xs">{r.last4 ?? '—'}</td>
                          <td className="py-1.5 px-4 text-right font-mono text-xs">${r.db_total_remaining.toFixed(2)}</td>
                          <td className="py-1.5 px-4 text-right font-mono text-xs font-semibold">${r.shopify_balance.toFixed(2)}</td>
                          <td className={`py-1.5 px-4 text-right font-mono text-xs font-semibold ${r.diff < 0 ? 'text-bad' : 'text-emerald-700'}`}>
                            {r.diff >= 0 ? '+' : ''}${r.diff.toFixed(2)}
                          </td>
                          <td className="py-1.5 px-4 text-right text-xs text-muted">{r.affected_grant_ids.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="border border-warn rounded-xl bg-yellow-50 p-6 mb-6">
                <h2 className="font-bold mb-2">Step 2 — Apply</h2>
                <p className="text-sm mb-3">
                  Click Apply to commit these {preview.discrepancy_count} adjustments. Each touched grant gets a ledger
                  entry with description &quot;Shopify sync reconciliation&quot;. This is reversible only via manual ledger edits — proceed deliberately.
                </p>
                {!confirmOpen ? (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={applyBusy}
                    className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                  >
                    Apply {preview.discrepancy_count} adjustments
                  </button>
                ) : (
                  <div className="border border-bad bg-red-50 rounded-lg p-4">
                    <p className="text-sm mb-3">
                      Confirm: apply <strong>{preview.discrepancy_count}</strong> reconciliation adjustments.
                      Net DB change: <strong>${(preview.total_db_to_add + preview.total_db_to_subtract).toFixed(2)}</strong>.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={runApply}
                        disabled={applyBusy}
                        className="bg-bad text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                      >
                        {applyBusy ? 'Applying…' : 'Yes, apply now'}
                      </button>
                      <button
                        onClick={() => setConfirmOpen(false)}
                        disabled={applyBusy}
                        className="bg-white border border-line px-5 py-2 rounded-lg font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                    {applyBusy && (
                      <p className="text-xs text-muted mt-3">
                        Updating grants, writing ledger entries, recomputing balances, pushing to Klaviyo. Don&apos;t close this tab.
                      </p>
                    )}
                  </div>
                )}
              </section>
            </>
          )}

          {preview.unmatched_shopify_card_ids_sample.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">
                Shopify cards with no matching grant in our DB (sample of {preview.unmatched_shopify_card_ids_sample.length})
              </summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These Shopify cards exist but aren&apos;t linked to any grant in Uprising. They&apos;re ignored by this tool.
                If they should be linked, run <Link href="/admin/link-gift-cards" className="text-ink hover:underline">Link gift cards</Link>.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">
                {preview.unmatched_shopify_card_ids_sample.join('\n')}
              </pre>
            </details>
          )}
        </>
      )}

      {applyResult && (
        <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
          <h2 className="font-bold text-emerald-800 mb-3">
            Apply complete in {(applyResult.duration_ms / 1000).toFixed(1)}s
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row label="Rows received" value={applyResult.rows_received.toLocaleString()} />
            <Row label="Applied" value={applyResult.rows_applied.toLocaleString()} bold />
            <Row label="In sync (no-op)" value={applyResult.rows_in_sync.toLocaleString()} />
            <Row label="Stale (DB drifted; skipped)" value={applyResult.rows_stale.toLocaleString()} />
            <Row label="Errored" value={applyResult.rows_errored.toLocaleString()} />
            <Row label="Net delta applied" value={`$${applyResult.total_delta_applied.toFixed(2)}`} />
            <Row label="Customer balances recomputed" value={applyResult.customers_recomputed.toLocaleString()} />
            <Row label="Klaviyo pushed" value={applyResult.klaviyo_pushed.toLocaleString()} />
            <Row label="Klaviyo errors" value={applyResult.klaviyo_errors.toLocaleString()} />
          </dl>

          {(applyResult.rows_stale > 0 || applyResult.rows_errored > 0) && (
            <details className="mt-4 bg-white border border-line rounded-lg p-3">
              <summary className="cursor-pointer text-sm font-semibold">Issues ({applyResult.rows_stale + applyResult.rows_errored})</summary>
              <ul className="text-xs space-y-1 mt-2">
                {applyResult.outcomes
                  .filter((o) => o.status === 'stale' || o.status === 'error')
                  .map((o, i) => (
                    <li key={i} className={o.status === 'error' ? 'text-bad' : 'text-muted'}>
                      <strong>{o.email}</strong> · {o.status} · {o.detail}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </main>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`text-right ${bold ? 'font-bold' : 'font-semibold'}`}>{value}</dd>
    </>
  );
}
