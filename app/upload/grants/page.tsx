'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import Link from 'next/link';
import { processGrantsUpload, type UploadOutcome } from './actions';

export default function UploadGrantsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);
  const [isPending, startTransition] = useTransition();
  const [topError, setTopError] = useState<string | null>(null);

  function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    setOutcome(null);
    setTopError(null);
    setFile(e.target.files?.[0] ?? null);
  }

  function submit() {
    if (!file) return;
    setTopError(null);
    setOutcome(null);
    const fd = new FormData();
    fd.append('csv', file);
    startTransition(async () => {
      try {
        const res = await processGrantsUpload(fd);
        setOutcome(res);
      } catch (e) {
        setTopError((e as Error).message);
      }
    });
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Upload event credits</h1>
      <p className="text-sm text-muted mb-8">
        CSV with columns: <code>code, adjust_amount, expires_on, customer_name, customer_email, reason, note</code>.
        Each unique <code>note</code> becomes a campaign. Customers must already exist in Klaviyo.
      </p>

      <div className="border border-line rounded-xl bg-white p-6 mb-6">
        <label className="block">
          <span className="text-sm font-medium">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFileSelected}
            className="mt-2 block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink file:text-white file:font-medium hover:file:opacity-90"
          />
        </label>

        {file && (
          <div className="mt-4 text-sm">
            <span className="font-medium">{file.name}</span>
            <span className="text-muted ml-2">{(file.size / 1024).toFixed(1)} KB</span>
          </div>
        )}

        <button
          onClick={submit}
          disabled={!file || isPending}
          className="mt-4 bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {isPending ? 'Processing… (this may take a minute)' : 'Process upload'}
        </button>

        {isPending && (
          <p className="mt-3 text-sm text-muted">
            Each row hits Klaviyo, Shopify, and the database — please don't close this tab.
          </p>
        )}
      </div>

      {topError && (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6">
          {topError}
        </div>
      )}

      {outcome && <Results outcome={outcome} />}
    </main>
  );
}

function Results({ outcome }: { outcome: UploadOutcome }) {
  if (outcome.message && !outcome.ok) {
    return (
      <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad">
        {outcome.message}
      </div>
    );
  }

  const failedRows = outcome.results.filter((r) => !r.ok);
  const okRows = outcome.results.filter((r) => r.ok);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total rows" value={String(outcome.totalRows)} />
        <Stat label="Succeeded" value={String(outcome.succeeded)} ok />
        <Stat label="Failed" value={String(outcome.failed)} bad={outcome.failed > 0} />
        <Stat label="Total $" value={`$${outcome.totalAmount.toFixed(2)}`} />
      </div>

      {outcome.campaigns.length > 0 && (
        <div className="border border-line rounded-xl bg-white p-5">
          <h2 className="font-semibold mb-3">Campaigns</h2>
          <ul className="text-sm space-y-1">
            {outcome.campaigns.map((c) => (
              <li key={c.eventId}><span className="font-medium">{c.name}</span> · {c.rowCount} grants</li>
            ))}
          </ul>
        </div>
      )}

      {failedRows.length > 0 && (
        <div className="border border-bad rounded-xl bg-red-50 p-5">
          <h2 className="font-semibold mb-3 text-bad">Failed rows ({failedRows.length})</h2>
          <ul className="text-sm space-y-2">
            {failedRows.map((r, i) => (
              <li key={i} className="text-bad">
                <span className="font-medium">Row {r.rowIndex + 1}</span> · {r.email} · {r.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {okRows.length > 0 && (
        <details className="border border-line rounded-xl bg-white p-5">
          <summary className="font-semibold cursor-pointer">Successful grants ({okRows.length})</summary>
          <table className="w-full text-sm mt-4">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3">Email</th>
                <th className="py-1 pr-3">Amount</th>
                <th className="py-1 pr-3">Expires</th>
                <th className="py-1 pr-3">Campaign</th>
              </tr>
            </thead>
            <tbody>
              {okRows.map((r, i) => (
                r.ok ? (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1 pr-3">{r.email}</td>
                    <td className="py-1 pr-3">${r.amount.toFixed(2)}</td>
                    <td className="py-1 pr-3">{r.expiresOn}</td>
                    <td className="py-1 pr-3">{r.campaignName}</td>
                  </tr>
                ) : null
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value, ok, bad }: { label: string; value: string; ok?: boolean; bad?: boolean }) {
  return (
    <div className={`p-4 rounded-lg border bg-white ${bad ? 'border-bad' : ok ? 'border-ok' : 'border-line'}`}>
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold ${bad ? 'text-bad' : ok ? 'text-ok' : ''}`}>{value}</div>
    </div>
  );
}
