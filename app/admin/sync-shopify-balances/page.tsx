'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

interface DiscrepancyRow {
  customer_id: string;
  email: string;
  customer_name: string | null;
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
  status: 'applied' | 'shopify_fixed' | 'in_sync' | 'stale' | 'error';
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
  rows_shopify_fixed: number;
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

function sortRows(rows: DiscrepancyRow[], sortKey: SortKey, sortDir: SortDir): DiscrepancyRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'email': cmp = (a.customer_name ?? a.email).localeCompare(b.customer_name ?? b.email); break;
      case 'last4': cmp = (a.last4 ?? '').localeCompare(b.last4 ?? ''); break;
      case 'db': cmp = a.db_total_remaining - b.db_total_remaining; break;
      case 'shopify': cmp = a.shopify_balance - b.shopify_balance; break;
      case 'diff': cmp = a.diff - b.diff; break;
      case 'expires': cmp = (a.expires_on_earliest ?? '').localeCompare(b.expires_on_earliest ?? ''); break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export default function SyncShopifyBalancesPage() {
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusyA, setApplyBusyA] = useState(false);
  const [applyBusyBKey, setApplyBusyBKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Section A — DB > Shopify (debit DB to match): bulk-selectable
  const [selectedKeysA, setSelectedKeysA] = useState<Set<string>>(new Set());
  const [confirmAOpen, setConfirmAOpen] = useState(false);
  const [sortKeyA, setSortKeyA] = useState<SortKey>('diff');
  // Most-negative first so largest debits show on top
  const [sortDirA, setSortDirA] = useState<SortDir>('asc');
  const [bulkExpA, setBulkExpA] = useState<string>('');

  // Section B — Shopify > DB (review individually): one-by-one only
  // The string here is the row key; the second part says which mode is being confirmed
  const [confirmingB, setConfirmingB] = useState<{ key: string; mode: 'fix_db' | 'fix_shopify' } | null>(null);
  const [sortKeyB, setSortKeyB] = useState<SortKey>('diff');
  // Largest positive first
  const [sortDirB, setSortDirB] = useState<SortDir>('desc');

  // Per-row expiration override (used by both sections)
  const [expOverrides, setExpOverrides] = useState<Record<string, string>>({});

  // Split preview rows into the two sections
  const rowsA = useMemo(() => (preview?.rows ?? []).filter((r) => r.diff < 0), [preview]);
  const rowsB = useMemo(() => (preview?.rows ?? []).filter((r) => r.diff > 0), [preview]);
  const sortedA = useMemo(() => sortRows(rowsA, sortKeyA, sortDirA), [rowsA, sortKeyA, sortDirA]);
  const sortedB = useMemo(() => sortRows(rowsB, sortKeyB, sortDirB), [rowsB, sortKeyB, sortDirB]);

  // When a fresh preview lands: default-select all of Section A, none of Section B,
  // and seed each row's expiration input with the existing earliest_expires_on
  useEffect(() => {
    if (!preview) {
      setSelectedKeysA(new Set());
      setConfirmingB(null);
      setExpOverrides({});
      return;
    }
    const aKeys = new Set<string>();
    const dates: Record<string, string> = {};
    preview.rows.forEach((r) => {
      const k = rowKey(r);
      dates[k] = r.expires_on_earliest ?? '';
      if (r.diff < 0) aKeys.add(k);
    });
    setSelectedKeysA(aKeys);
    setExpOverrides(dates);
  }, [preview]);

  function toggleRowA(k: string) {
    setSelectedKeysA((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  function toggleAllA() {
    setSelectedKeysA((prev) => {
      if (prev.size === rowsA.length) return new Set();
      return new Set(rowsA.map(rowKey));
    });
  }

  function setExp(k: string, v: string) {
    setExpOverrides((prev) => ({ ...prev, [k]: v }));
  }
  function applyExpToAllSelectedA(date: string) {
    if (!date || selectedKeysA.size === 0) return;
    setExpOverrides((prev) => {
      const next = { ...prev };
      selectedKeysA.forEach((k) => { next[k] = date; });
      return next;
    });
  }
  function copyExpToAllSelectedA(fromKey: string) {
    const date = expOverrides[fromKey];
    if (!date) return;
    applyExpToAllSelectedA(date);
  }

  function toggleSortA(col: SortKey) {
    if (sortKeyA === col) setSortDirA((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKeyA(col); setSortDirA(col === 'email' || col === 'last4' || col === 'expires' ? 'asc' : 'asc'); }
  }
  function toggleSortB(col: SortKey) {
    if (sortKeyB === col) setSortDirB((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKeyB(col); setSortDirB(col === 'email' || col === 'last4' || col === 'expires' ? 'asc' : 'desc'); }
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

  function payloadFor(rows: DiscrepancyRow[], mode: 'fix_db' | 'fix_shopify') {
    return rows.map((r) => {
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
        mode,
      };
    });
  }

  async function runApply(rows: DiscrepancyRow[], mode: 'fix_db' | 'fix_shopify', busySetter: (b: boolean) => void) {
    if (rows.length === 0) {
      setError('Nothing to apply.');
      return;
    }
    busySetter(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/sync-shopify-balances/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: payloadFor(rows, mode) }),
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
      busySetter(false);
    }
  }

  async function runApplyA() {
    setConfirmAOpen(false);
    const toApply = rowsA.filter((r) => selectedKeysA.has(rowKey(r)));
    await runApply(toApply, 'fix_db', setApplyBusyA);
  }

  async function runApplyOneB(row: DiscrepancyRow, mode: 'fix_db' | 'fix_shopify') {
    const k = rowKey(row);
    setConfirmingB(null);
    setApplyBusyBKey(k);
    try {
      await runApply([row], mode, () => {});
    } finally {
      setApplyBusyBKey(null);
    }
  }

  function exportBToCsv() {
    if (rowsB.length === 0) return;
    const header = 'email,customer_id,app_balance,shopify_balance,diff,last4';
    const lines = rowsB.map((r) =>
      [
        r.email,
        r.customer_id,
        r.db_total_remaining.toFixed(2),
        r.shopify_balance.toFixed(2),
        r.diff.toFixed(2),
        r.last4 ?? '',
      ]
        .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
        .join(',')
    );
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shopify-greater-than-db-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const aSelectedCount = selectedKeysA.size;
  const allASelected = rowsA.length > 0 && aSelectedCount === rowsA.length;
  const someASelected = aSelectedCount > 0 && !allASelected;

  const aSelectedTotal = useMemo(() => {
    let total = 0;
    for (const r of rowsA) {
      if (selectedKeysA.has(rowKey(r))) total += r.diff; // diff is negative
    }
    return total;
  }, [rowsA, selectedKeysA]);

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Sync gift card balances from Shopify</h1>
      <p className="text-sm text-muted mb-2">
        Reconcile our DB with Shopify. The tool surfaces drift in two separate tables so each direction
        is handled deliberately.
      </p>
      <p className="text-xs text-muted mb-6">
        <strong>Section A (DB &gt; Shopify):</strong> customer redeemed in Shopify but our app missed it.
        Apply debits the DB to match.{' '}
        <strong>Section B (Shopify &gt; DB):</strong> Shopify has more credit than our DB knows about.
        Review one-by-one — applying credits the DB to match Shopify; if instead you need to debit Shopify,
        do that manually in Shopify admin.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-2">Step 1 — Preview</h2>
        <p className="text-sm text-muted mb-4">
          Pulls all gift cards from Shopify and compares to our DB at the customer level. No DB writes.
        </p>
        <button
          onClick={runPreview}
          disabled={previewBusy || applyBusyA || !!applyBusyBKey}
          className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {previewBusy ? 'Pulling from Shopify…' : 'Run preview'}
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
              <Row label="Shopify cards total" value={preview.shopify_cards_total.toLocaleString()} />
              <Row label="Customers with a linked card" value={preview.customers_with_card.toLocaleString()} />
              <Row label="In sync" value={preview.in_sync_count.toLocaleString()} />
              <Row label="Section A — DB > Shopify" value={`${rowsA.length} customers · $${Math.abs(rowsA.reduce((s, r) => s + r.diff, 0)).toFixed(2)}`} bold={rowsA.length > 0} />
              <Row label="Section B — Shopify > DB" value={`${rowsB.length} customers · $${rowsB.reduce((s, r) => s + r.diff, 0).toFixed(2)}`} bold={rowsB.length > 0} />
            </dl>
          </section>

          {rowsA.length === 0 && rowsB.length === 0 ? (
            <div className="p-6 rounded-xl border border-emerald-200 bg-emerald-50 text-sm">
              <strong className="text-emerald-800">All in sync.</strong> Every customer&apos;s DB total matches Shopify&apos;s current balance. Nothing to apply.
            </div>
          ) : (
            <>
              {/* SECTION A: DB > Shopify (debit DB) */}
              {rowsA.length > 0 && (
                <section className="border border-bad rounded-xl bg-white p-0 mb-8 overflow-hidden">
                  <div className="px-6 py-4 border-b border-line bg-red-50">
                    <h2 className="font-bold text-bad">Section A — DB has more than Shopify ({rowsA.length})</h2>
                    <p className="text-xs text-muted mt-1">
                      The customer&apos;s gift card has been redeemed in Shopify but our DB still shows the higher balance.
                      Apply debits the DB grants to match Shopify. Bulk-applicable.
                    </p>
                  </div>
                  <div className="px-6 py-3 bg-slate-50 border-b border-line flex items-center gap-3 flex-wrap text-sm">
                    <span className="text-muted">Set expiration for all selected:</span>
                    <input
                      type="date"
                      value={bulkExpA}
                      onChange={(e) => setBulkExpA(e.target.value)}
                      className="border border-line rounded px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => applyExpToAllSelectedA(bulkExpA)}
                      disabled={!bulkExpA || aSelectedCount === 0}
                      className="bg-ink text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-50"
                    >
                      Apply to {aSelectedCount} selected
                    </button>
                    <span className="text-xs text-muted">· Or use ↓ on a row to copy that row&apos;s date down</span>
                    <span className="ml-auto text-sm">
                      <strong>{aSelectedCount}</strong> of {rowsA.length} selected
                    </span>
                  </div>
                  <div className="overflow-auto max-h-[500px]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-50 border-b border-line z-10">
                        <tr className="text-left text-muted">
                          <th className="py-2 px-3 font-medium w-10">
                            <input
                              type="checkbox"
                              checked={allASelected}
                              ref={(el) => { if (el) el.indeterminate = someASelected; }}
                              onChange={toggleAllA}
                              className="cursor-pointer"
                            />
                          </th>
                          <SortHeader col="email" label="Customer" sortKey={sortKeyA} sortDir={sortDirA} onSort={toggleSortA} />
                          <SortHeader col="last4" label="Card last4" sortKey={sortKeyA} sortDir={sortDirA} onSort={toggleSortA} />
                          <SortHeader col="db" label="DB has" sortKey={sortKeyA} sortDir={sortDirA} onSort={toggleSortA} align="right" />
                          <SortHeader col="shopify" label="Shopify says" sortKey={sortKeyA} sortDir={sortDirA} onSort={toggleSortA} align="right" />
                          <SortHeader col="diff" label="Diff" sortKey={sortKeyA} sortDir={sortDirA} onSort={toggleSortA} align="right" />
                          <SortHeader col="expires" label="Expires on" sortKey={sortKeyA} sortDir={sortDirA} onSort={toggleSortA} />
                          <th className="py-2 px-3 font-medium text-right">Grants</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedA.map((r) => {
                          const k = rowKey(r);
                          const isSelected = selectedKeysA.has(k);
                          const exp = expOverrides[k] ?? '';
                          const dateChanged = !!exp && exp !== (r.expires_on_earliest ?? '');
                          return (
                            <tr key={k} className={`border-b border-line last:border-0 ${isSelected ? '' : 'opacity-50'}`}>
                              <td className="py-1.5 px-3">
                                <input type="checkbox" checked={isSelected} onChange={() => toggleRowA(k)} className="cursor-pointer" />
                              </td>
                              <td className="py-1.5 px-3">
                                <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline text-xs">
                                  {r.customer_name ? r.customer_name : r.email}
                                </Link>
                                {r.customer_name && <div className="text-[11px] text-muted">{r.email}</div>}
                                {!r.shopify_enabled && <span className="ml-2 text-xs text-muted">(disabled)</span>}
                              </td>
                              <td className="py-1.5 px-3 font-mono text-xs">{r.last4 ?? '—'}</td>
                              <td className="py-1.5 px-3 text-right font-mono text-xs">${r.db_total_remaining.toFixed(2)}</td>
                              <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold">${r.shopify_balance.toFixed(2)}</td>
                              <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold text-bad">
                                ${r.diff.toFixed(2)}
                              </td>
                              <td className="py-1.5 px-3">
                                <div className="flex items-center gap-1">
                                  <input
                                    type="date"
                                    value={exp}
                                    onChange={(e) => setExp(k, e.target.value)}
                                    className={`text-xs border rounded px-1 py-0.5 ${dateChanged ? 'border-warn bg-yellow-50' : 'border-line'}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => copyExpToAllSelectedA(k)}
                                    disabled={!exp || aSelectedCount === 0}
                                    className="text-xs px-1.5 py-0.5 rounded border border-line text-muted hover:text-ink hover:border-ink disabled:opacity-30 disabled:cursor-not-allowed"
                                    title="Copy this date to all selected rows"
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
                  <div className="px-6 py-4 border-t border-line bg-red-50">
                    {!confirmAOpen ? (
                      <button
                        onClick={() => setConfirmAOpen(true)}
                        disabled={applyBusyA || aSelectedCount === 0}
                        className="bg-bad text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                      >
                        Apply {aSelectedCount} debit{aSelectedCount === 1 ? '' : 's'} to DB (${aSelectedTotal.toFixed(2)})
                      </button>
                    ) : (
                      <div>
                        <p className="text-sm mb-3">
                          Confirm: apply <strong>{aSelectedCount}</strong> debit{aSelectedCount === 1 ? '' : 's'} totaling <strong>${aSelectedTotal.toFixed(2)}</strong>.
                          Each touched grant gets a &quot;Shopify sync reconciliation&quot; ledger entry.
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={runApplyA}
                            disabled={applyBusyA}
                            className="bg-bad text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                          >
                            {applyBusyA ? 'Applying…' : 'Yes, apply now'}
                          </button>
                          <button
                            onClick={() => setConfirmAOpen(false)}
                            disabled={applyBusyA}
                            className="bg-white border border-line px-5 py-2 rounded-lg font-medium"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* SECTION B: Shopify > DB (review individually) */}
              {rowsB.length > 0 && (
                <section className="border border-warn rounded-xl bg-white p-0 mb-8 overflow-hidden">
                  <div className="px-6 py-4 border-b border-line bg-yellow-50 flex items-start justify-between flex-wrap gap-3">
                    <div>
                      <h2 className="font-bold text-amber-800">Section B — Shopify has more than DB ({rowsB.length})</h2>
                      <p className="text-xs text-muted mt-1">
                        Investigate each one. Apply credits the DB to match Shopify (use only when Shopify is the truth).
                        Otherwise debit Shopify in admin or export for later. <strong>One row at a time — no bulk apply.</strong>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={exportBToCsv}
                      className="bg-white border border-line px-3 py-1.5 rounded-lg text-xs font-medium hover:border-ink"
                    >
                      Export {rowsB.length} to CSV
                    </button>
                  </div>
                  <div className="overflow-auto max-h-[500px]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-50 border-b border-line z-10">
                        <tr className="text-left text-muted">
                          <SortHeader col="email" label="Customer" sortKey={sortKeyB} sortDir={sortDirB} onSort={toggleSortB} />
                          <SortHeader col="last4" label="Card last4" sortKey={sortKeyB} sortDir={sortDirB} onSort={toggleSortB} />
                          <SortHeader col="db" label="DB has" sortKey={sortKeyB} sortDir={sortDirB} onSort={toggleSortB} align="right" />
                          <SortHeader col="shopify" label="Shopify says" sortKey={sortKeyB} sortDir={sortDirB} onSort={toggleSortB} align="right" />
                          <SortHeader col="diff" label="Diff" sortKey={sortKeyB} sortDir={sortDirB} onSort={toggleSortB} align="right" />
                          <SortHeader col="expires" label="Expires on" sortKey={sortKeyB} sortDir={sortDirB} onSort={toggleSortB} />
                          <th className="py-2 px-3 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedB.map((r) => {
                          const k = rowKey(r);
                          const confirmHere = confirmingB?.key === k ? confirmingB.mode : null;
                          const isApplying = applyBusyBKey === k;
                          const exp = expOverrides[k] ?? '';
                          const dateChanged = !!exp && exp !== (r.expires_on_earliest ?? '');
                          const isBusy = !!applyBusyBKey || applyBusyA;
                          return (
                            <tr key={k} className="border-b border-line last:border-0">
                              <td className="py-1.5 px-3">
                                <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline text-xs">
                                  {r.customer_name ? r.customer_name : r.email}
                                </Link>
                                {r.customer_name && <div className="text-[11px] text-muted">{r.email}</div>}
                                {!r.shopify_enabled && <span className="ml-2 text-xs text-muted">(disabled)</span>}
                              </td>
                              <td className="py-1.5 px-3 font-mono text-xs">{r.last4 ?? '—'}</td>
                              <td className="py-1.5 px-3 text-right font-mono text-xs">${r.db_total_remaining.toFixed(2)}</td>
                              <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold">${r.shopify_balance.toFixed(2)}</td>
                              <td className="py-1.5 px-3 text-right font-mono text-xs font-semibold text-emerald-700">
                                +${r.diff.toFixed(2)}
                              </td>
                              <td className="py-1.5 px-3">
                                <input
                                  type="date"
                                  value={exp}
                                  onChange={(e) => setExp(k, e.target.value)}
                                  className={`text-xs border rounded px-1 py-0.5 ${dateChanged ? 'border-warn bg-yellow-50' : 'border-line'}`}
                                />
                              </td>
                              <td className="py-1.5 px-3 text-right">
                                {confirmHere === null ? (
                                  <div className="flex gap-1 justify-end">
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingB({ key: k, mode: 'fix_shopify' })}
                                      disabled={isBusy}
                                      className="bg-amber-600 text-white px-2 py-1 rounded text-xs font-medium disabled:opacity-50"
                                      title={`Debit Shopify by $${r.diff.toFixed(2)} so it matches DB ($${r.db_total_remaining.toFixed(2)})`}
                                    >
                                      Fix Shopify (-${r.diff.toFixed(2)})
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingB({ key: k, mode: 'fix_db' })}
                                      disabled={isBusy}
                                      className="bg-emerald-600 text-white px-2 py-1 rounded text-xs font-medium disabled:opacity-50"
                                      title={`Credit DB by $${r.diff.toFixed(2)} so it matches Shopify ($${r.shopify_balance.toFixed(2)})`}
                                    >
                                      Fix DB (+${r.diff.toFixed(2)})
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex gap-1 justify-end items-center">
                                    <span className="text-[11px] text-muted mr-1">
                                      {confirmHere === 'fix_shopify'
                                        ? `Debit Shopify $${r.diff.toFixed(2)}?`
                                        : `Credit DB $${r.diff.toFixed(2)}?`}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => runApplyOneB(r, confirmHere)}
                                      disabled={isApplying}
                                      className="bg-bad text-white px-2 py-1 rounded text-xs font-medium disabled:opacity-50"
                                    >
                                      {isApplying ? '…' : 'Confirm'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingB(null)}
                                      disabled={isApplying}
                                      className="bg-white border border-line px-2 py-1 rounded text-xs font-medium"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          {preview.unmatched_shopify_card_ids_sample.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">
                Shopify cards with no matching customer in our DB (sample of {preview.unmatched_shopify_card_ids_sample.length})
              </summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These Shopify cards exist but aren&apos;t linked to any customer in Uprising.
                If they should be linked, run <Link href="/admin/link-by-code" className="text-ink hover:underline">Link gift cards by code</Link>.
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
            <Row label="DB fixed (Section A or 'Fix DB')" value={applyResult.rows_applied.toLocaleString()} bold />
            <Row label="Shopify fixed ('Fix Shopify')" value={applyResult.rows_shopify_fixed.toLocaleString()} bold />
            <Row label="In sync (no-op)" value={applyResult.rows_in_sync.toLocaleString()} />
            <Row label="Stale (drifted; skipped)" value={applyResult.rows_stale.toLocaleString()} />
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
          <p className="text-xs text-muted mt-3">
            Run preview again to confirm the discrepancies are resolved (or to see what&apos;s left).
          </p>
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
