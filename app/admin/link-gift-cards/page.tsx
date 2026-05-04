'use client';

import { useState, type ChangeEvent } from 'react';
import Link from 'next/link';

interface SampleLink {
  email: string;
  shopify_gift_card_id: string;
  loyalty_card_code: string;
  last4: string;
}

interface Result {
  csv_rows: number;
  customers_in_csv: number;
  customers_in_db: number;
  customers_already_linked: number;
  customers_linked: number;
  customers_failed: number;
  customers_in_csv_not_in_db: number;
  customers_with_no_eligible_card: number;
  duration_ms: number;
  sample_links: SampleLink[];
  emails_not_in_db_sample: string[];
}

export default function LinkGiftCardsPage() {
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
      const res = await fetch('/api/admin/link-gift-cards', { method: 'POST', body: fd });
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
      <h1 className="text-3xl font-bold mt-2 mb-1">Link gift cards from Master Rise file</h1>
      <p className="text-sm text-muted mb-6">
        For any customer in our DB whose <code>shopify_gift_card_id</code>, <code>loyalty_card_code</code>,
        or <code>shopify_gift_card_last4</code> is missing, this tool fills in the gaps from the Master Rise CSV.
        It picks the most recent non-disabled card per email. <strong>No grants are created, no Shopify or Klaviyo
        calls are made — DB only.</strong> Already-linked customers are skipped.
      </p>
      <p className="text-sm text-muted mb-6">
        Use this when an upload fails with &quot;No matching enabled Shopify gift card for loyalty_card_code…&quot;.
        After running this, re-upload the failed rows — they&apos;ll hit the existing gift card directly instead of
        searching Shopify.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <label className="block">
          <span className="text-sm font-medium">Master Rise CSV</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onSelect}
            disabled={busy}
            className="mt-2 block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink file:text-white file:font-medium hover:file:opacity-90"
          />
        </label>
        <p className="text-xs text-muted mt-2">
          Required columns: <code>shopify_gift_card_id</code>, <code>code</code>, <code>customer_email</code>,
          <code> created_at</code>. Optional: <code>disabled_at</code>, <code>deleted_at</code>.
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
          {busy ? 'Linking…' : 'Run link'}
        </button>
      </section>

      {error && (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
            <h2 className="font-bold text-emerald-800 mb-3">
              Linked {result.customers_linked.toLocaleString()} customers in {(result.duration_ms / 1000).toFixed(1)}s
            </h2>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Row label="CSV rows" value={result.csv_rows.toLocaleString()} />
              <Row label="Unique emails in CSV" value={result.customers_in_csv.toLocaleString()} />
              <Row label="Customers in our DB" value={result.customers_in_db.toLocaleString()} />
              <Row label="Already fully linked" value={result.customers_already_linked.toLocaleString()} />
              <Row label="Linked this run" value={result.customers_linked.toLocaleString()} />
              <Row label="Failed (DB write error)" value={result.customers_failed.toLocaleString()} />
              <Row label="In CSV but not in our DB" value={result.customers_in_csv_not_in_db.toLocaleString()} />
              <Row label="No eligible card (all disabled)" value={result.customers_with_no_eligible_card.toLocaleString()} />
            </dl>
          </section>

          {result.sample_links.length > 0 && (
            <section className="border border-line rounded-xl bg-white p-6 mb-6">
              <h2 className="font-bold mb-3">Sample of newly-linked customers (first {result.sample_links.length})</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-line">
                    <th className="py-2 font-medium">Email</th>
                    <th className="py-2 font-medium">Code</th>
                    <th className="py-2 font-medium">Last 4</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sample_links.map((s, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="py-1.5 text-xs">{s.email}</td>
                      <td className="py-1.5 font-mono text-xs">{s.loyalty_card_code}</td>
                      <td className="py-1.5 font-mono text-xs">{s.last4}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {result.emails_not_in_db_sample.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">
                Emails in CSV but not in our DB ({result.customers_in_csv_not_in_db.toLocaleString()} total, showing {result.emails_not_in_db_sample.length})
              </summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These customers exist in the Master Rise file but have no row in our <code>customers</code> table.
                If you want them linked, first run the master importer or seed them via the upload flow.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">
                {result.emails_not_in_db_sample.join('\n')}
              </pre>
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
