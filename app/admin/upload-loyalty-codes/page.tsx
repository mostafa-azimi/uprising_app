'use client';

import { useState, type ChangeEvent } from 'react';
import Link from 'next/link';

interface MatchedRow {
  csv_row: number;
  email: string;
  customer_id: string;
  csv_code: string;
  current_code: string | null;
  status: 'new' | 'unchanged' | 'conflict';
}

interface MissingRow {
  csv_row: number;
  email: string;
  csv_code: string;
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  csv_total_rows: number;
  csv_duplicate_emails: string[];
  matched: MatchedRow[];
  not_found: MissingRow[];
  invalid_rows: Array<{ csv_row: number; reason: string; raw: { email?: string; loyalty_card_code?: string } }>;
  counts: { new: number; unchanged: number; conflict: number; not_found: number; invalid: number };
  duration_ms: number;
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  status: 'updated' | 'unchanged' | 'skipped_conflict' | 'error';
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  updated: number;
  unchanged: number;
  skipped_conflict: number;
  errored: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

export default function UploadLoyaltyCodesPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);

  function onSelect(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setPreview(null);
    setApplyResult(null);
    setError(null);
  }

  async function runPreview() {
    if (!file) return;
    setPreviewBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      const fd = new FormData();
      fd.append('csv', file);
      const res = await fetch('/api/admin/upload-loyalty-codes/preview', { method: 'POST', body: fd });
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
    // Apply only matched rows (new + conflict if overwrite is on; we always include unchanged for harmless idempotency)
    const rowsToApply = preview.matched.filter((r) =>
      r.status === 'new' || r.status === 'unchanged' || (r.status === 'conflict' && overwriteConflicts)
    );
    if (rowsToApply.length === 0) {
      setError('No rows would be applied with current settings.');
      setConfirmOpen(false);
      return;
    }
    setApplyBusy(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const res = await fetch('/api/admin/upload-loyalty-codes/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rowsToApply,
          overwrite_conflicts: overwriteConflicts,
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

  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <div className="flex items-baseline gap-3 mt-2 mb-1 flex-wrap">
        <h1 className="text-3xl font-bold">Upload loyalty codes</h1>
        <span className="text-xs text-amber-700 bg-yellow-100 border border-yellow-300 px-2 py-0.5 rounded-full uppercase tracking-wide">Temporary</span>
      </div>
      <p className="text-sm text-muted mb-2">
        Bulk-update <code>customers.loyalty_card_code</code> from a CSV. Two columns: <code>email,loyalty_card_code</code>.
      </p>
      <p className="text-xs text-muted mb-6">
        This is a <strong>data cleanup tool</strong> for backfilling loyalty codes on customers created via skip-Klaviyo
        uploads. New uploads via the normal flow set the code automatically. After running this, use <Link href="/admin/link-by-code" className="text-ink hover:underline">Link gift cards by code</Link> to attach Shopify IDs, then <Link href="/admin/sync-shopify-balances" className="text-ink hover:underline">Sync balances from Shopify</Link> to reconcile.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-2">Step 1 — Upload CSV</h2>
        <label className="block">
          <span className="text-sm font-medium">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onSelect}
            disabled={previewBusy || applyBusy}
            className="mt-2 block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink file:text-white file:font-medium hover:file:opacity-90"
          />
        </label>
        <p className="text-xs text-muted mt-2">
          Required columns (header row): <code>email</code>, <code>loyalty_card_code</code>. Other columns are ignored.
        </p>
        {file && (
          <div className="mt-3 text-sm">
            <span className="font-medium">{file.name}</span>
            <span className="text-muted ml-2">{(file.size / 1024).toFixed(1)} KB</span>
          </div>
        )}
        <button
          onClick={runPreview}
          disabled={!file || previewBusy || applyBusy}
          className="mt-4 bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {previewBusy ? 'Parsing…' : 'Preview'}
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
            <h2 className="font-bold mb-3">Preview</h2>
            <p className="text-xs text-muted mb-3">Generated at {new Date(preview.generated_at).toLocaleString()}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Row label="CSV total rows" value={preview.csv_total_rows.toLocaleString()} />
              <Row label="Will SET (new code)" value={preview.counts.new.toLocaleString()} bold />
              <Row label="Already correct (no-op)" value={preview.counts.unchanged.toLocaleString()} />
              <Row label="Conflicts (different code in DB)" value={preview.counts.conflict.toLocaleString()} />
              <Row label="Customer not in DB" value={preview.counts.not_found.toLocaleString()} />
              <Row label="Invalid CSV rows" value={preview.counts.invalid.toLocaleString()} />
            </dl>
          </section>

          {preview.matched.length > 0 && (
            <section className="border border-line rounded-xl bg-white p-0 mb-6 overflow-hidden">
              <div className="px-6 py-4 border-b border-line">
                <h2 className="font-bold">Matched customers ({preview.matched.length})</h2>
              </div>
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 border-b border-line">
                    <tr className="text-left text-muted">
                      <th className="py-2 px-3 font-medium">Status</th>
                      <th className="py-2 px-3 font-medium">Email</th>
                      <th className="py-2 px-3 font-medium">CSV code</th>
                      <th className="py-2 px-3 font-medium">Current code in DB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.matched.map((r, i) => (
                      <tr key={i} className="border-b border-line last:border-0">
                        <td className="py-1.5 px-3 text-xs">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="py-1.5 px-3 text-xs">{r.email}</td>
                        <td className="py-1.5 px-3 font-mono text-xs">{r.csv_code}</td>
                        <td className="py-1.5 px-3 font-mono text-xs text-muted">{r.current_code ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {preview.not_found.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6">
              <summary className="cursor-pointer font-semibold">
                Customers not in DB ({preview.not_found.length})
              </summary>
              <p className="text-xs text-muted mt-2 mb-2">
                These emails are in your CSV but don&apos;t match a customer in our DB. They&apos;ll be skipped.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">
                {preview.not_found.map((r) => `${r.email},${r.csv_code}`).join('\n')}
              </pre>
            </details>
          )}

          {preview.invalid_rows.length > 0 && (
            <details className="border border-bad rounded-xl bg-red-50 p-4 mb-6" open>
              <summary className="cursor-pointer font-semibold text-bad">
                Invalid CSV rows ({preview.invalid_rows.length})
              </summary>
              <ul className="text-xs space-y-1 mt-2 text-bad">
                {preview.invalid_rows.map((r, i) => (
                  <li key={i}>row {r.csv_row}: {r.reason}</li>
                ))}
              </ul>
            </details>
          )}

          {preview.csv_duplicate_emails.length > 0 && (
            <details className="border border-warn rounded-xl bg-yellow-50 p-4 mb-6">
              <summary className="cursor-pointer font-semibold">
                Duplicate emails in CSV ({preview.csv_duplicate_emails.length})
              </summary>
              <p className="text-xs text-muted mt-2 mb-2">
                Only the first occurrence is processed; later duplicates are ignored.
              </p>
              <pre className="text-xs bg-slate-50 border border-line rounded-lg p-3 overflow-auto max-h-64">
                {preview.csv_duplicate_emails.join('\n')}
              </pre>
            </details>
          )}

          {preview.matched.length > 0 && (
            <section className="border border-warn rounded-xl bg-yellow-50 p-6 mb-6">
              <h2 className="font-bold mb-2">Step 2 — Apply</h2>

              {preview.counts.conflict > 0 && (
                <label className="flex items-start gap-2 text-sm mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overwriteConflicts}
                    onChange={(e) => setOverwriteConflicts(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Overwrite conflicting codes</span>
                    <span className="block text-xs text-muted">
                      {preview.counts.conflict} customer{preview.counts.conflict === 1 ? '' : 's'} already
                      ha{preview.counts.conflict === 1 ? 's' : 've'} a <em>different</em> loyalty code in our DB.
                      With this off, those rows are skipped. With it on, the CSV value overwrites.
                    </span>
                  </span>
                </label>
              )}

              <p className="text-sm mb-3">
                Will update <strong>{preview.counts.new + (overwriteConflicts ? preview.counts.conflict : 0)}</strong> customer{preview.counts.new + (overwriteConflicts ? preview.counts.conflict : 0) === 1 ? '' : 's'}.
                Skipped: {preview.counts.unchanged} unchanged
                {!overwriteConflicts && preview.counts.conflict > 0 && `, ${preview.counts.conflict} conflict`}
                {preview.counts.not_found > 0 && `, ${preview.counts.not_found} not found`}
                {preview.counts.invalid > 0 && `, ${preview.counts.invalid} invalid`}.
              </p>

              {!confirmOpen ? (
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={applyBusy || (preview.counts.new + (overwriteConflicts ? preview.counts.conflict : 0)) === 0}
                  className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                >
                  Apply
                </button>
              ) : (
                <div className="border border-bad bg-red-50 rounded-lg p-4">
                  <p className="text-sm mb-3">
                    Confirm: write <strong>{preview.counts.new + (overwriteConflicts ? preview.counts.conflict : 0)}</strong> loyalty codes to the customers table.
                    {overwriteConflicts && preview.counts.conflict > 0 && (
                      <> <strong>{preview.counts.conflict} existing code{preview.counts.conflict === 1 ? '' : 's'} will be overwritten.</strong></>
                    )}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={runApply}
                      disabled={applyBusy}
                      className="bg-bad text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
                    >
                      {applyBusy ? 'Applying…' : 'Yes, write to DB'}
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
            Applied in {(applyResult.duration_ms / 1000).toFixed(1)}s
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row label="Rows received" value={applyResult.rows_received.toLocaleString()} />
            <Row label="Updated" value={applyResult.updated.toLocaleString()} bold />
            <Row label="Unchanged (no-op)" value={applyResult.unchanged.toLocaleString()} />
            <Row label="Skipped (conflict)" value={applyResult.skipped_conflict.toLocaleString()} />
            <Row label="Errored" value={applyResult.errored.toLocaleString()} />
          </dl>
          {applyResult.errored > 0 && (
            <details className="mt-4 bg-white border border-line rounded-lg p-3">
              <summary className="cursor-pointer text-sm font-semibold text-bad">Errors ({applyResult.errored})</summary>
              <ul className="text-xs space-y-1 mt-2 text-bad">
                {applyResult.outcomes.filter((o) => o.status === 'error').map((o, i) => (
                  <li key={i}><strong>{o.email}</strong> · {o.detail}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: 'new' | 'unchanged' | 'conflict' }) {
  const styles: Record<string, string> = {
    new: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    unchanged: 'bg-slate-100 text-slate-600 border-slate-200',
    conflict: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${styles[status]}`}>{status}</span>;
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`text-right ${bold ? 'font-bold' : 'font-semibold'}`}>{value}</dd>
    </>
  );
}
