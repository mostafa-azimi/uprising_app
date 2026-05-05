'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

interface UniqueMatchRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
  shopify_gift_card_id: string;
  shopify_masked_code: string | null;
  shopify_balance: number;
  shopify_enabled: boolean;
  app_balance: number;
  unlinked_grant_ids: string[];
}

interface AmbiguousRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
  candidate_count: number;
  candidates: Array<{ id: string; balance: number; enabled: boolean; masked_code: string | null }>;
}

interface NotFoundRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
}

interface NoCodeRow {
  customer_id: string;
  email: string;
  app_balance: number;
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  shopify_cards_total: number;
  total_unlinked_customers: number;
  unique_matches: UniqueMatchRow[];
  ambiguous: AmbiguousRow[];
  not_found: NotFoundRow[];
  no_code: NoCodeRow[];
  duration_ms: number;
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  status: 'linked' | 'already_linked' | 'stale' | 'error';
  grants_linked: number;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  customers_linked: number;
  customers_already_linked: number;
  rows_stale: number;
  rows_errored: number;
  total_grants_linked: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

export default function LinkByCodePage() {
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
    setSelectedKeys(new Set(preview.unique_matches.map((r) => r.customer_id)));
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
      if (prev.size === preview.unique_matches.length) return new Set();
      return new Set(preview.unique_matches.map((r) => r.customer_id));
    });
  }

  async function runPreview() {
    setPreviewBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await fetch('/api/admin/link-by-code/preview', { method: 'POST' });
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
    const rowsToApply = preview.unique_matches.filter((r) => selectedKeys.has(r.customer_id));
    if (rowsToApply.length === 0) {
      setError('Select at least one row to link.');
      setConfirmOpen(false);
      return;
    }
    setApplyBusy(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const res = await fetch('/api/admin/link-by-code/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rowsToApply.map((r) => ({
            customer_id: r.customer_id,
            email: r.email,
            loyalty_card_code: r.loyalty_card_code,
            last4: r.last4,
            shopify_gift_card_id: r.shopify_gift_card_id,
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
  const allSelected = preview && selectedCount === preview.unique_matches.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const selectedTotals = useMemo(() => {
    if (!preview) return { count: 0, appBalance: 0, shopifyBalance: 0 };
    let count = 0, appBalance = 0, shopifyBalance = 0;
    for (const r of preview.unique_matches) {
      if (!selectedKeys.has(r.customer_id)) continue;
      count++;
      appBalance += r.app_balance;
      shopifyBalance += r.shopify_balance;
    }
    return { count, appBalance, shopifyBalance };
  }, [preview, selectedKeys]);

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <div className="flex items-baseline gap-3 mt-2 mb-1 flex-wrap">
        <h1 className="text-3xl font-bold">Link gift cards by code</h1>
        <span className="text-xs text-amber-700 bg-yellow-100 border border-yellow-300 px-2 py-0.5 rounded-full uppercase tracking-wide">Temporary</span>
      </div>
      <p className="text-sm text-muted mb-2">
        For every customer with <code>loyalty_card_code</code> set but <code>shopify_gift_card_id</code> NULL, this matches their code&apos;s
        last 4 characters against Shopify gift cards and offers to link the unique matches.
      </p>
      <p className="text-xs text-muted mb-6">
        <strong>No Shopify writes.</strong> No card creation. No balance changes. Only sets the metadata link.
        After running this, use <Link href="/admin/sync-shopify-balances" className="text-ink hover:underline">Sync balances from Shopify</Link> to reconcile balance deltas.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-2">Step 1 — Preview</h2>
        <p className="text-sm text-muted mb-4">
          Pulls all gift cards from Shopify and matches by last 4 of <code>loyalty_card_code</code>.
        </p>
        <button
          onClick={runPreview}
          disabled={previewBusy || applyBusy}
          className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {previewBusy ? 'Pulling Shopify cards…' : 'Run preview'}
        </button>
        {previewBusy && (
          <p className="text-xs text-muted mt-2">Pages through Shopify gift cards (~30–60s for several thousand cards).</p>
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
              <Row label="Shopify cards in store" value={preview.shopify_cards_total.toLocaleString()} />
              <Row label="Customers needing a link" value={preview.total_unlinked_customers.toLocaleString()} bold />
              <Row label="Unique matches" value={preview.unique_matches.length.toLocaleString()} bold />
              <Row label="Ambiguous (multiple last-4)" value={preview.ambiguous.length.toLocaleString()} />
              <Row label="Not found in Shopify" value={preview.not_found.length.toLocaleString()} />
              <Row label="No loyalty code in DB" value={preview.no_code.length.toLocaleString()} />
            </dl>
          </section>

          {preview.unique_matches.length > 0 && (
            <section className="border border-line rounded-xl bg-white p-0 mb-6 overflow-hidden">
              <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="font-bold">Unique matches ({preview.unique_matches.length})</h2>
                  <p className="text-xs text-muted">
                    Each row matches exactly one Shopify card by last 4. Eyeball the masked code, balance, and enabled status before applying.
                  </p>
                </div>
                <div className="text-sm">
                  <strong>{selectedCount}</strong> of {preview.unique_matches.length} selected
                </div>
              </div>
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 border-b border-line">
                    <tr className="text-left text-muted">
                      <th className="py-2 px-3 font-medium w-10">
                        <input
                          type="checkbox"
                          checked={!!allSelected}
                          ref={(el) => { if (el) el.indeterminate = !!someSelected; }}
                          onChange={toggleAll}
                          className="cursor-pointer"
                        />
                      </th>
                      <th className="py-2 px-3 font-medium">Customer</th>
                      <th className="py-2 px-3 font-medium">DB code (last 4)</th>
                      <th className="py-2 px-3 font-medium">Shopify card</th>
                      <th className="py-2 px-3 font-medium text-right">App balance</th>
                      <th className="py-2 px-3 font-medium text-right">Shopify balance</th>
                      <th className="py-2 px-3 font-medium">Enabled?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.unique_matches.map((r) => {
                      const isSelected = selectedKeys.has(r.customer_id);
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
                          <td className="py-1.5 px-3 text-xs">
                            <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline">{r.email}</Link>
                          </td>
                          <td className="py-1.5 px-3 font-mono text-xs">…{r.last4}</td>
                          <td className="py-1.5 px-3 font-mono text-xs">{r.shopify_masked_code ?? `…${r.last4}`}</td>
                          <td className="py-1.5 px-3 text-right font-mono text-xs">${r.app_balance.toFixed(2)}</td>
                          <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold">${r.shopify_balance.toFixed(2)}</td>
                          <td className="py-1.5 px-3 text-xs">{r.shopify_enabled ? 'yes' : <span className="text-bad">no</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {preview.ambiguous.length > 0 && (
            <details className="border border-warn rounded-xl bg-yellow-50 p-4 mb-6" open>
              <summary className="cursor-pointer font-semibold">Ambiguous — multiple cards share the same last-4 ({preview.ambiguous.length})</summary>
              <p className="text-xs text-muted mt-2 mb-3">
                Resolve manually. Look up the customer in Shopify to identify the correct card, then link it via SQL.
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3">Email</th>
                    <th className="py-1 pr-3">Code</th>
                    <th className="py-1 pr-3">Last 4</th>
                    <th className="py-1 pr-3">Candidate cards</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.ambiguous.map((r) => (
                    <tr key={r.customer_id} className="border-t border-line">
                      <td className="py-1 pr-3">{r.email}</td>
                      <td className="py-1 pr-3 font-mono">{r.loyalty_card_code}</td>
                      <td className="py-1 pr-3 font-mono">{r.last4}</td>
                      <td className="py-1 pr-3">
                        {r.candidates.map((c) => (
                          <div key={c.id} className="font-mono">
                            {c.id.split('/').pop()} · ${c.balance.toFixed(2)} · {c.enabled ? 'enabled' : 'disabled'}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {preview.not_found.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">Not found in Shopify ({preview.not_found.length})</summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These customers have a loyalty code in our DB but no Shopify gift card has matching last 4.
                Either the code is wrong, the card was deleted from Shopify, or the gift card filter didn&apos;t return enough cards.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">
                {preview.not_found.map((r) => `${r.email}\t${r.loyalty_card_code}`).join('\n')}
              </pre>
            </details>
          )}

          {preview.no_code.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">Missing loyalty code in DB ({preview.no_code.length})</summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These customers have unlinked grants but no <code>loyalty_card_code</code> set.
                Run <Link href="/admin/upload-loyalty-codes" className="text-ink hover:underline">Upload loyalty codes</Link> first to populate them.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">
                {preview.no_code.map((r) => `${r.email}\t$${r.app_balance.toFixed(2)}`).join('\n')}
              </pre>
            </details>
          )}

          {preview.unique_matches.length > 0 && (
            <section className="border border-warn rounded-xl bg-yellow-50 p-6 mb-6">
              <h2 className="font-bold mb-2">Step 2 — Apply</h2>
              <p className="text-sm mb-3">
                Will link <strong>{selectedTotals.count}</strong> selected customer{selectedTotals.count === 1 ? '' : 's'} to their Shopify gift cards.
                App balance total: <strong>${selectedTotals.appBalance.toFixed(2)}</strong>.
                Shopify balance total: <strong>${selectedTotals.shopifyBalance.toFixed(2)}</strong>.
                The diff (${(selectedTotals.shopifyBalance - selectedTotals.appBalance).toFixed(2)}) gets reconciled by the Sync balances tool afterward.
              </p>
              {!confirmOpen ? (
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={applyBusy || selectedCount === 0}
                  className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                >
                  Link {selectedCount} customer{selectedCount === 1 ? '' : 's'}
                </button>
              ) : (
                <div className="border border-bad bg-red-50 rounded-lg p-4">
                  <p className="text-sm mb-3">
                    Confirm: link <strong>{selectedCount}</strong> customer{selectedCount === 1 ? '' : 's'} (and all their unlinked active grants) to the Shopify cards shown.
                    Metadata only — no Shopify writes, no balance changes.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={runApply}
                      disabled={applyBusy}
                      className="bg-bad text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                    >
                      {applyBusy ? 'Linking…' : 'Yes, link them'}
                    </button>
                    <button
                      onClick={() => setConfirmOpen(false)}
                      disabled={applyBusy}
                      className="bg-white border border-line px-5 py-2 rounded-lg font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {applyResult && (
        <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
          <h2 className="font-bold text-emerald-800 mb-3">
            Linked in {(applyResult.duration_ms / 1000).toFixed(1)}s
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row label="Rows received" value={applyResult.rows_received.toLocaleString()} />
            <Row label="Customers linked" value={applyResult.customers_linked.toLocaleString()} bold />
            <Row label="Already linked (no-op)" value={applyResult.customers_already_linked.toLocaleString()} />
            <Row label="Stale (skipped)" value={applyResult.rows_stale.toLocaleString()} />
            <Row label="Errored" value={applyResult.rows_errored.toLocaleString()} />
            <Row label="Total grants linked" value={applyResult.total_grants_linked.toLocaleString()} />
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
