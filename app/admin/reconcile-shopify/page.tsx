'use client';

import { useState, type ChangeEvent } from 'react';
import Link from 'next/link';

interface Result {
  csv_rows: number;
  grants_in_db: number;
  grants_matched: number;
  grants_unchanged: number;
  grants_updated: number;
  grants_zeroed: number;
  customers_resynced: number;
  klaviyo_pushed: number;
  klaviyo_errors: number;
  total_diff_amount: number;
  duration_ms: number;
  unmatched_card_ids: string[];
  sample_changes: Array<{
    email: string;
    gift_card_id: string;
    db_remaining: number;
    shopify_balance: number;
    new_status: string;
  }>;
}

export default function ReconcileShopifyPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSelect(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setResult(null);
    setError(null);
  }

  async function upload() {
    if (!file) return;
    setBusy(true); setResult(null); setError(null);
    try {
      const fd = new FormData();
      fd.append('csv', file);
      const res = await fetch('/api/admin/reconcile-shopify', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setResult(json as Result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/settings" className="text-sm text-muted hover:text-ink">← Settings</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Reconcile from Shopify</h1>
      <p className="text-sm text-muted mb-6">
        Upload a Shopify gift cards CSV export. For every gift card that maps to a grant in our database,
        we update the grant's <code>remaining_amount</code> to match Shopify's <code>Current Balance</code>,
        recompute customer balances, and push the new values to Klaviyo. Shopify is treated as the source of truth.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <label className="block">
          <span className="text-sm font-medium">Shopify gift cards export CSV</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onSelect}
            disabled={busy}
            className="mt-2 block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink file:text-white file:font-medium hover:file:opacity-90"
          />
        </label>
        <p className="text-xs text-muted mt-2">
          Shopify admin → Gift cards → Export. Required columns: <code>Id</code>, <code>Last Characters</code>, <code>Current Balance</code>, <code>Enabled?</code>.
        </p>

        {file && (
          <div className="mt-3 text-sm">
            <span className="font-medium">{file.name}</span>
            <span className="text-muted ml-2">{(file.size / 1024).toFixed(1)} KB</span>
          </div>
        )}

        <button
          onClick={upload}
          disabled={!file || busy}
          className="mt-4 bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {busy ? 'Reconciling…' : 'Run reconciliation'}
        </button>
      </section>

      {error && <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6 whitespace-pre-wrap">{error}</div>}

      {result && (
        <>
          <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
            <h2 className="font-bold text-emerald-800 mb-3">Reconciliation complete in {(result.duration_ms / 1000).toFixed(1)}s</h2>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Row label="CSV rows" value={result.csv_rows.toLocaleString()} />
              <Row label="Grants in our DB" value={result.grants_in_db.toLocaleString()} />
              <Row label="Grants matched" value={result.grants_matched.toLocaleString()} />
              <Row label="Grants unchanged" value={result.grants_unchanged.toLocaleString()} />
              <Row label="Grants updated" value={result.grants_updated.toLocaleString()} />
              <Row label="Grants zeroed (Shopify $0)" value={result.grants_zeroed.toLocaleString()} />
              <Row label="Customers re-synced" value={result.customers_resynced.toLocaleString()} />
              <Row label="Klaviyo pushed" value={result.klaviyo_pushed.toLocaleString()} />
              <Row label="Klaviyo errors" value={result.klaviyo_errors.toLocaleString()} />
              <Row label="Total diff (Shopify − DB)" value={`$${result.total_diff_amount.toFixed(2)}`} />
              <Row label="Unmatched Shopify cards" value={result.unmatched_card_ids.length.toLocaleString()} />
            </dl>
          </section>

          {result.sample_changes.length > 0 && (
            <section className="border border-line rounded-xl bg-white p-6 mb-6">
              <h2 className="font-bold mb-3">Sample of changes (first {result.sample_changes.length})</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-line">
                    <th className="py-2 font-medium">Customer</th>
                    <th className="py-2 font-medium text-right">DB had</th>
                    <th className="py-2 font-medium text-right">Shopify says</th>
                    <th className="py-2 font-medium">New status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sample_changes.map((c, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="py-1.5 text-xs">{c.email}</td>
                      <td className="py-1.5 text-right font-mono text-xs">${c.db_remaining.toFixed(2)}</td>
                      <td className="py-1.5 text-right font-mono text-xs font-semibold">${c.shopify_balance.toFixed(2)}</td>
                      <td className="py-1.5 text-xs text-muted">{c.new_status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {result.unmatched_card_ids.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">Unmatched Shopify card IDs ({result.unmatched_card_ids.length})</summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These Shopify gift cards exist in your export but have no matching grant in our database
                (likely cards that pre-date our import or non-Rise gift cards). They're ignored by this tool.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">{result.unmatched_card_ids.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </>
  );
}
