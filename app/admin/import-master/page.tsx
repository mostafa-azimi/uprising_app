'use client';

import { useState, type ChangeEvent } from 'react';
import Link from 'next/link';

interface Result {
  rows_parsed: number;
  customers_upserted: number;
  grants_created: number;
  active_grants: number;
  total_active_balance: number;
  rows_skipped_disabled: number;
  rows_skipped_no_email: number;
  duration_ms: number;
}

export default function ImportMasterPage() {
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
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('csv', file);
      const res = await fetch('/api/admin/import-master', { method: 'POST', body: fd });
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
      <h1 className="text-3xl font-bold mt-2 mb-1">Import Master Rise file</h1>
      <p className="text-sm text-muted mb-6">
        One-shot importer for the Rise master export (one row per Shopify gift card).
        Upserts customers, creates one grant per non-disabled row with balance &gt; 0,
        and sets each grant's expiration to <strong>6 months after</strong> its <code>created_at</code>.
        Disabled or zero-balance rows just create the customer record. Auto-expiration of
        past-due grants is controlled by a toggle on the expirations dashboard.
      </p>

      <section className="border border-line rounded-xl bg-amber-50 border-amber-200 p-4 mb-6 text-sm">
        <strong>Run the wipe SQL first</strong> if you're starting fresh — otherwise this importer
        upserts on top of your existing data. Wipe SQL is in the previous chat / migration files.
      </section>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <label className="block">
          <span className="text-sm font-medium">Master CSV from Rise</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onSelect}
            disabled={busy}
            className="mt-2 block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink file:text-white file:font-medium hover:file:opacity-90"
          />
        </label>
        <p className="text-xs text-muted mt-2">
          Expected columns: <code>shopify_gift_card_id, code, first_name, last_name, customer_name,
          customer_email, order_id, initial_value, balance, created_at, expires_on, note,
          gift_card_source, reason, fulfilled_at, disabled_at, deleted_at</code>.
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
          {busy ? 'Importing… (up to a minute)' : 'Run import'}
        </button>
      </section>

      {error && <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6 whitespace-pre-wrap">{error}</div>}

      {result && (
        <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6">
          <h2 className="font-bold text-emerald-800 mb-3">Import complete in {(result.duration_ms / 1000).toFixed(1)}s</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row label="Rows parsed" value={result.rows_parsed.toLocaleString()} />
            <Row label="Customers upserted" value={result.customers_upserted.toLocaleString()} />
            <Row label="Grants created (active)" value={result.grants_created.toLocaleString()} />
            <Row label="Total active balance" value={`$${result.total_active_balance.toFixed(2)}`} />
            <Row label="Rows skipped (disabled)" value={result.rows_skipped_disabled.toLocaleString()} />
            <Row label="Rows skipped (no email)" value={result.rows_skipped_no_email.toLocaleString()} />
          </dl>
          <div className="mt-4 flex gap-3 text-sm">
            <Link href="/customers" className="text-ink underline">View customers →</Link>
            <Link href="/reports/expirations" className="text-ink underline">View expirations report →</Link>
          </div>
        </section>
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
