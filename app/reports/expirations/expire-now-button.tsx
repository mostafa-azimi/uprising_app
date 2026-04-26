'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ExpireNowButton() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setConfirm(false);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/expire-past-date', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const errCount = (json.errors ?? []).length;
      setResult(
        `Expired ${json.grants_expired} grants across ${json.customers_processed} customers — ` +
        `total $${json.total_amount_expired.toFixed(2)} in ${(json.duration_ms / 1000).toFixed(1)}s.` +
        (errCount > 0 ? ` ${errCount} errors (see sync_log).` : '')
      );
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => setConfirm(true)}
        disabled={busy}
        className="bg-bad text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {busy ? 'Expiring…' : 'Run expiration sweep now'}
      </button>

      {result && <div className="mt-3 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700">{result}</div>}
      {error && <div className="mt-3 p-3 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error}</div>}

      {confirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h2 className="text-lg font-bold mb-2">Run expiration sweep now?</h2>
            <p className="text-sm text-muted mb-4">
              This finds every active grant whose expiration date has passed (before today) and expires it:
              debits Shopify, marks expired in our DB, writes ledger entries, updates Klaviyo balances.
              The daily cron does this automatically — only run manually for catch-up.
            </p>
            <p className="text-sm font-semibold text-bad mb-4">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(false)} className="px-4 py-2 rounded-lg text-sm border border-line hover:bg-slate-50">Cancel</button>
              <button onClick={run} className="px-4 py-2 rounded-lg text-sm bg-bad text-white font-medium">Yes, expire now</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
