'use client';

import { useEffect, useMemo, useState } from 'react';
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
  expiration_changed?: boolean;
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

type SortKey = 'email' | 'last4' | 'db' | 'shopify' | 'diff' | 'expires';
type SortDir = 'asc' | 'desc';

function rowKey(r: { customer_id: string; shopify_gift_card_id: string }): string {
  return `${r.customer_id}|${r.shopify_gift_card_id}`;
}

export default function SyncShopifyBalancesPage() {
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Per-row selection (default: all selected after preview loads)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Per-row expiration override (default: row's earliest existing expiration)
  const [expOverrides, setExpOverrides] = useState<Record<string, string>>({});
  // Bulk date input for "Set expiration for all selected"
  const [bulkExp, setBulkExp] = useState<string>('');
  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>('diff');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // When a fresh preview lands, default-select all rows and seed expiration inputs
  useEffect(() => {
    if (!preview) {
      setSelectedKeys(new Set());
      setExpOverrides({});
      return;
    }
    const keys = new Set<string>();
    const dates: Record<string, string> = {};
    preview.rows.forEach((r) => {
      const k = rowKey(r);
      keys.add(k);
      dates[k] = r.expires_on_earliest ?? '';
    });
    setSelectedKeys(keys);
    setExpOverrides(dates);
  }, [preview]);

  const sortedRows = useMemo(() => {
    if (!preview) return [];
    const rows = [...preview.rows];
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'email': cmp = a.email.localeCompare(b.email); break;
        case 'last4': cmp = (a.last4 ?? '').localeCompare(b.last4 ?? ''); break;
        case 'db': cmp = a.db_total_remaining - b.db_total_remaining; break;
        case 'shopify': cmp = a.shopify_balance - b.shopify_balance; break;
        case 'diff': cmp = a.diff - b.diff; break;
        case 'expires': cmp = (a.expires_on_earliest ?? '').localeCompare(b.expires_on_earliest ?? ''); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [preview, sortKey, sortDir]);

  function toggleSort(col: SortKey) {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col);
      // Numeric columns default to desc (largest first); string columns default to asc.
      setSortDir(col === 'email' || col === 'last4' || col === 'expires' ? 'asc' : 'desc');
    }
  }

  function toggleRow(k: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  function toggleAll() {
    if (!preview) return;
    setSelectedKeys((prev) => {
      if (prev.size === preview.rows.length) return new Set();
      return new Set(preview.rows.map(rowKey));
    });
  }

  function setExp(k: string, v: string) {
    setExpOverrides((prev) => ({ ...prev, [k]: v }));
  }

  // Bulk-set: apply a date to every currently-selected row
  function applyExpToAllSelected(date: string) {
    if (!date || selectedKeys.size === 0) return;
    setExpOverrides((prev) => {
      const next = { ...prev };
      selectedKeys.forEach((k) => { next[k] = date; });
      return next;
    });
  }

  // Per-row "fill down": copy one row's date to every selected row
  function copyExpToAllSelected(fromKey: string) {
    const date = expOverrides[fromKey];
    if (!date) return;
    applyExpToAllSelected(date);
  }

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
    const rowsToApply = preview.rows.filter((r) => selectedKeys.has(rowKey(r)));
    if (rowsToApply.length === 0) {
      setError('Select at least one row to apply.');
      setConfirmOpen(false);
      return;
    }
    setApplyBusy(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const res = await fetch('/api/admin/sync-shopify-balances/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rowsToApply.map((r) => {
            const k = rowKey(r);
            const exp = (expOverrides[k] ?? '').trim();
            return {
              customer_id: r.customer_id,
              email: r.email,
              shopify_gift_card_id: r.shopify_gift_card_id,
              shopify_balance: r.shopify_balance,
              db_total_remaining: r.db_total_remaining,
              diff: r.diff,
              expires_on: exp || null,
            };
          }),
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

  // Selected-only totals for the apply summary
  const selectedTotals = useMemo(() => {
    if (!preview) return { sub: 0, add: 0 };
    let sub = 0, add = 0;
    for (const r of preview.rows) {
      if (!selectedKeys.has(rowKey(r))) continue;
      if (r.diff < 0) sub += r.diff; else add += r.diff;
    }
    return { sub, add };
  }, [preview, selectedKeys]);

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Sync gift card balances from Shopify</h1>
      <p className="text-sm text-muted mb-2">
        Pull every gift card balance directly from Shopify, compare with our DB, and reconcile any drift.
        Two-step: preview shows discrepancies (read-only), then you select which rows to apply and click Apply to commit.
      </p>
      <p className="text-xs text-muted mb-6">
        On apply, Shopify becomes the source of truth: each grant&apos;s remaining_amount is adjusted so the customer&apos;s
        DB total for that gift card matches Shopify. Each touched grant gets a <code>type=adjust</code> ledger entry
        with description &quot;Shopify sync reconciliation — set to $X (was $Y)&quot;. When the diff is negative (DB &gt; Shopify),
        we debit the oldest-expiring grant first (FIFO). When positive, we credit the newest grant (longest expiration).
        You can also override the expiration date per row — that updates all active grants for that gift card to the new date.
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
              <Row label="DB will DECREASE by (all)" value={`$${Math.abs(preview.total_db_to_subtract).toFixed(2)}`} />
              <Row label="DB will INCREASE by (all)" value={`$${preview.total_db_to_add.toFixed(2)}`} />
              <Row label="Net DB change (all)" value={`$${(preview.total_db_to_add + preview.total_db_to_subtract).toFixed(2)}`} bold />
            </dl>
          </section>

          {preview.discrepancy_count === 0 ? (
            <div className="p-6 rounded-xl border border-emerald-200 bg-emerald-50 text-sm">
              <strong className="text-emerald-800">All in sync.</strong> Every customer&apos;s DB total matches Shopify&apos;s current balance for their gift card. Nothing to apply.
            </div>
          ) : (
            <>
              <section className="border border-line rounded-xl bg-white p-0 mb-6 overflow-hidden">
                <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h2 className="font-bold">Discrepancies ({preview.discrepancy_count})</h2>
                    <p className="text-xs text-muted">
                      Click any header to sort. Negative diff = DB had more than Shopify (will debit on apply).
                    </p>
                  </div>
                  <div className="text-sm">
                    <strong>{selectedCount}</strong> of {preview.rows.length} selected
                  </div>
                </div>
                <div className="px-6 py-3 bg-slate-50 border-b border-line flex items-center gap-3 flex-wrap text-sm">
                  <span className="text-muted">Set expiration for all selected:</span>
                  <input
                    type="date"
                    value={bulkExp}
                    onChange={(e) => setBulkExp(e.target.value)}
                    className="border border-line rounded px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => applyExpToAllSelected(bulkExp)}
                    disabled={!bulkExp || selectedCount === 0}
                    className="bg-ink text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-50"
                    title="Set this date on every selected row"
                  >
                    Apply to {selectedCount} selected
                  </button>
                  <span className="text-xs text-muted">
                    · Or use the <strong>↓</strong> button on any row to copy that row&apos;s date down to all selected.
                  </span>
                </div>
                <div className="overflow-auto max-h-[600px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 border-b border-line z-10">
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
                        <SortHeader col="email" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHeader col="last4" label="Card last4" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHeader col="db" label="DB has" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                        <SortHeader col="shopify" label="Shopify says" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                        <SortHeader col="diff" label="Diff" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                        <SortHeader col="expires" label="Expires on" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <th className="py-2 px-3 font-medium text-right">Grants</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((r) => {
                        const k = rowKey(r);
                        const isSelected = selectedKeys.has(k);
                        const exp = expOverrides[k] ?? '';
                        const dateChanged = !!exp && exp !== (r.expires_on_earliest ?? '');
                        return (
                          <tr
                            key={k}
                            className={`border-b border-line last:border-0 ${isSelected ? '' : 'opacity-50'}`}
                          >
                            <td className="py-1.5 px-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleRow(k)}
                                className="cursor-pointer"
                              />
                            </td>
                            <td className="py-1.5 px-3">
                              <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline text-xs">{r.email}</Link>
                              {!r.shopify_enabled && <span className="ml-2 text-xs text-muted">(disabled)</span>}
                            </td>
                            <td className="py-1.5 px-3 font-mono text-xs">{r.last4 ?? '—'}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs">${r.db_total_remaining.toFixed(2)}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold">${r.shopify_balance.toFixed(2)}</td>
                            <td className={`py-1.5 px-3 text-right font-mono text-xs font-semibold ${r.diff < 0 ? 'text-bad' : 'text-emerald-700'}`}>
                              {r.diff >= 0 ? '+' : ''}${r.diff.toFixed(2)}
                            </td>
                            <td className="py-1.5 px-3">
                              <div className="flex items-center gap-1">
                                <input
                                  type="date"
                                  value={exp}
                                  onChange={(e) => setExp(k, e.target.value)}
                                  className={`text-xs border rounded px-1 py-0.5 ${dateChanged ? 'border-warn bg-yellow-50' : 'border-line'}`}
                                  title={dateChanged ? `Will update from ${r.expires_on_earliest ?? '(none)'}` : 'Earliest grant expiration on this card'}
                                />
                                <button
                                  type="button"
                                  onClick={() => copyExpToAllSelected(k)}
                                  disabled={!exp || selectedCount === 0}
                                  className="text-xs px-1.5 py-0.5 rounded border border-line text-muted hover:text-ink hover:border-ink disabled:opacity-30 disabled:cursor-not-allowed"
                                  title={`Copy this date (${exp || 'none'}) to all ${selectedCount} selected rows`}
                                >
                                  ↓
                                </button>
                              </div>
                            </td>
                            <td className="py-1.5 px-3 text-right text-xs text-muted">{r.affected_grant_ids.length}</td>
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
                  Click Apply to commit <strong>{selectedCount}</strong> selected adjustment{selectedCount === 1 ? '' : 's'}.
                  Each touched grant gets a ledger entry tagged &quot;Shopify sync reconciliation&quot;.
                  Selected net DB change: <strong>${(selectedTotals.add + selectedTotals.sub).toFixed(2)}</strong>{' '}
                  (-${Math.abs(selectedTotals.sub).toFixed(2)} / +${selectedTotals.add.toFixed(2)}).
                </p>
                {!confirmOpen ? (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={applyBusy || selectedCount === 0}
                    className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                  >
                    Apply {selectedCount} adjustment{selectedCount === 1 ? '' : 's'}
                  </button>
                ) : (
                  <div className="border border-bad bg-red-50 rounded-lg p-4">
                    <p className="text-sm mb-3">
                      Confirm: apply <strong>{selectedCount}</strong> reconciliation adjustment{selectedCount === 1 ? '' : 's'}.
                      Net DB change: <strong>${(selectedTotals.add + selectedTotals.sub).toFixed(2)}</strong>.
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

function SortHeader({
  col, label, sortKey, sortDir, onSort, align = 'left',
}: {
  col: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (col: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === col;
  const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={`py-2 px-3 font-medium select-none cursor-pointer hover:text-ink ${align === 'right' ? 'text-right' : ''}`}
      onClick={() => onSort(col)}
      title="Click to sort"
    >
      {label}{arrow}
    </th>
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
