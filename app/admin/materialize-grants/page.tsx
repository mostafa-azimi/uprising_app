'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

interface MaterializeRow {
  customer_id: string;
  email: string;
  customer_has_card: boolean;
  customer_card_id: string | null;
  total_balance: number;
  grant_count: number;
  earliest_expires_on: string | null;
  grant_ids: string[];
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  total_customers: number;
  customers_zero_balance: number;
  customers_positive_balance: number;
  total_to_create_in_shopify: number;
  rows: MaterializeRow[];
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  status: 'created_card' | 'credited_existing_card' | 'zeroed_only' | 'in_sync' | 'stale' | 'error';
  shopify_gift_card_id?: string | null;
  loyalty_card_code?: string | null;
  amount_credited?: number;
  grants_touched: number;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  shopify_cards_created: number;
  shopify_cards_credited: number;
  zero_balance_zeroed: number;
  rows_in_sync: number;
  rows_stale: number;
  rows_errored: number;
  total_balance_materialized: number;
  klaviyo_pushed: number;
  klaviyo_errors: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

export default function MaterializeGrantsPage() {
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!preview) {
      setSelectedKeys(new Set());
      return;
    }
    setSelectedKeys(new Set(preview.rows.map((r) => r.customer_id)));
  }, [preview]);

  function toggleRow(id: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!preview) return;
    setSelectedKeys((prev) => {
      if (prev.size === preview.rows.length) return new Set();
      return new Set(preview.rows.map((r) => r.customer_id));
    });
  }

  async function runPreview() {
    setPreviewBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await fetch('/api/admin/materialize-grants/preview', { method: 'POST' });
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
    const rowsToApply = preview.rows.filter((r) => selectedKeys.has(r.customer_id));
    if (rowsToApply.length === 0) {
      setError('Select at least one customer to materialize.');
      setConfirmOpen(false);
      return;
    }
    setApplyBusy(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const res = await fetch('/api/admin/materialize-grants/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rowsToApply.map((r) => ({
            customer_id: r.customer_id,
            email: r.email,
            total_balance: r.total_balance,
            grant_count: r.grant_count,
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

  const selectedCount = selectedKeys.size;
  const allSelected = preview && selectedCount === preview.rows.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const selectedTotals = useMemo(() => {
    if (!preview) return { positive: 0, zero: 0, sumBalance: 0, toCreate: 0 };
    let positive = 0, zero = 0, sumBalance = 0, toCreate = 0;
    for (const r of preview.rows) {
      if (!selectedKeys.has(r.customer_id)) continue;
      if (r.total_balance >= 0.005) {
        positive++;
        sumBalance += r.total_balance;
        if (!r.customer_has_card) toCreate++;
      } else zero++;
    }
    return { positive, zero, sumBalance, toCreate };
  }, [preview, selectedKeys]);

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Materialize unlinked grants in Shopify</h1>
      <p className="text-sm text-muted mb-2">
        Find every customer whose active grants are missing a Shopify gift card link
        (typically from skip-Shopify uploads), then materialize them. Two-step: preview shows
        the affected customers (read-only), then you select which to apply.
      </p>
      <p className="text-xs text-muted mb-6">
        On apply, customers with a positive balance get a new Shopify gift card created with their balance,
        all their unlinked active grants are linked to it, and the new code is pushed to Klaviyo.
        Customers whose total is $0 get their grants marked <code>fully_redeemed</code> (no Shopify call).
        Customers who already have a Shopify card on their profile get that card credited by the
        unlinked balance instead of a new card creation.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-2">Step 1 — Preview</h2>
        <p className="text-sm text-muted mb-4">
          Lists every customer with unlinked active grants. No DB writes, no Shopify or Klaviyo calls.
        </p>
        <button
          onClick={runPreview}
          disabled={previewBusy || applyBusy}
          className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {previewBusy ? 'Pulling…' : 'Run preview'}
        </button>
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
              <Row label="Customers needing materialization" value={preview.total_customers.toLocaleString()} bold />
              <Row label="With positive balance" value={preview.customers_positive_balance.toLocaleString()} />
              <Row label="With zero balance" value={preview.customers_zero_balance.toLocaleString()} />
              <Row label="New Shopify cards to create" value={preview.total_to_create_in_shopify.toLocaleString()} />
            </dl>
          </section>

          {preview.total_customers === 0 ? (
            <div className="p-6 rounded-xl border border-emerald-200 bg-emerald-50 text-sm">
              <strong className="text-emerald-800">All grants are linked.</strong> Nothing to materialize.
            </div>
          ) : (
            <>
              <section className="border border-line rounded-xl bg-white p-0 mb-6 overflow-hidden">
                <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h2 className="font-bold">Affected customers ({preview.total_customers})</h2>
                    <p className="text-xs text-muted">
                      Sorted by balance descending. Uncheck any you want to skip.
                    </p>
                  </div>
                  <div className="text-sm">
                    <strong>{selectedCount}</strong> of {preview.rows.length} selected
                  </div>
                </div>
                <div className="overflow-auto max-h-[600px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 border-b border-line">
                      <tr className="text-left text-muted">
                        <th className="py-2 px-3 font-medium w-10">
                          <input
                            type="checkbox"
                            checked={!!allSelected}
                            ref={(el) => { if (el) el.indeterminate = !!someSelected; }}
                            onChange={toggleAll}
                            title={allSelected ? 'Deselect all' : 'Select all'}
                            className="cursor-pointer"
                          />
                        </th>
                        <th className="py-2 px-3 font-medium">Customer</th>
                        <th className="py-2 px-3 font-medium text-right">Balance</th>
                        <th className="py-2 px-3 font-medium text-right">Grants</th>
                        <th className="py-2 px-3 font-medium">Earliest expiration</th>
                        <th className="py-2 px-3 font-medium">Action on apply</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => {
                        const isSelected = selectedKeys.has(r.customer_id);
                        const action = r.total_balance < 0.005
                          ? 'Mark fully_redeemed (no Shopify)'
                          : r.customer_has_card
                            ? 'Credit existing Shopify card'
                            : 'Create new Shopify card';
                        return (
                          <tr key={r.customer_id} className={`border-b border-line last:border-0 ${isSelected ? '' : 'opacity-50'}`}>
                            <td className="py-1.5 px-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleRow(r.customer_id)}
                                className="cursor-pointer"
                              />
                            </td>
                            <td className="py-1.5 px-3">
                              <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline text-xs">{r.email}</Link>
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold">${r.total_balance.toFixed(2)}</td>
                            <td className="py-1.5 px-3 text-right text-xs text-muted">{r.grant_count}</td>
                            <td className="py-1.5 px-3 text-xs text-muted">{r.earliest_expires_on ?? '—'}</td>
                            <td className="py-1.5 px-3 text-xs">{action}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="border border-warn rounded-xl bg-yellow-50 p-6 mb-6">
                <h2 className="font-bold mb-2">Step 2 — Apply</h2>
                <p className="text-sm mb-3">
                  Selected: <strong>{selectedTotals.positive}</strong> positive-balance customers
                  (sum <strong>${selectedTotals.sumBalance.toFixed(2)}</strong>; <strong>{selectedTotals.toCreate}</strong> new Shopify cards),
                  plus <strong>{selectedTotals.zero}</strong> zero-balance customers (status fix only).
                </p>
                <p className="text-xs text-muted mb-3">
                  This <strong>creates real gift cards in Shopify</strong> with the corresponding balances.
                  Once created, the customer can redeem against them at checkout.
                </p>
                {!confirmOpen ? (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={applyBusy || selectedCount === 0}
                    className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                  >
                    Materialize {selectedCount} customer{selectedCount === 1 ? '' : 's'}
                  </button>
                ) : (
                  <div className="border border-bad bg-red-50 rounded-lg p-4">
                    <p className="text-sm mb-3">
                      Confirm: materialize <strong>{selectedCount}</strong> customer{selectedCount === 1 ? '' : 's'}.
                      This will create <strong>{selectedTotals.toCreate}</strong> new Shopify gift card{selectedTotals.toCreate === 1 ? '' : 's'} for ${selectedTotals.sumBalance.toFixed(2)} total.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={runApply}
                        disabled={applyBusy}
                        className="bg-bad text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                      >
                        {applyBusy ? 'Materializing…' : 'Yes, do it'}
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
                        Each positive-balance customer requires a Shopify API call. With many customers this can take a minute or two — don&apos;t close this tab.
                      </p>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {applyResult && (
        <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
          <h2 className="font-bold text-emerald-800 mb-3">
            Materialization complete in {(applyResult.duration_ms / 1000).toFixed(1)}s
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row label="Rows received" value={applyResult.rows_received.toLocaleString()} />
            <Row label="New Shopify cards created" value={applyResult.shopify_cards_created.toLocaleString()} bold />
            <Row label="Existing cards credited" value={applyResult.shopify_cards_credited.toLocaleString()} />
            <Row label="$0 grants marked fully_redeemed" value={applyResult.zero_balance_zeroed.toLocaleString()} />
            <Row label="In sync (no-op)" value={applyResult.rows_in_sync.toLocaleString()} />
            <Row label="Stale (skipped)" value={applyResult.rows_stale.toLocaleString()} />
            <Row label="Errored" value={applyResult.rows_errored.toLocaleString()} />
            <Row label="Total balance materialized" value={`$${applyResult.total_balance_materialized.toFixed(2)}`} />
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
