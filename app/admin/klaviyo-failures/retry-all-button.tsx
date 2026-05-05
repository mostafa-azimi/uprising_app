'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RetryAllButton({ failureCount }: { failureCount: number }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ succeeded: number; failed: number; rows_received: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleRetryAll() {
    setBusy(true);
    setError(null);
    setResult(null);
    setConfirming(false);
    try {
      const res = await fetch('/api/admin/klaviyo-failures/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retry_all_pending: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setResult({
        succeeded: json.succeeded,
        failed: json.failed,
        rows_received: json.rows_received,
      });
      // Refresh the page so resolved rows drop off
      setTimeout(() => router.refresh(), 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (failureCount === 0) return null;

  return (
    <div className="flex flex-col items-end gap-2">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="bg-bad text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          Retry all {failureCount} pending
        </button>
      ) : (
        <div className="flex items-center gap-2 bg-red-50 border border-bad rounded-lg px-3 py-2">
          <span className="text-sm">Retry all {failureCount}?</span>
          <button
            type="button"
            onClick={handleRetryAll}
            disabled={busy}
            className="bg-bad text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-50"
          >
            {busy ? 'Retrying…' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="bg-white border border-line px-3 py-1 rounded text-xs font-medium"
          >
            Cancel
          </button>
        </div>
      )}
      {busy && (
        <p className="text-xs text-muted">
          Concurrency 5, 3-retry per customer. Up to ~5 minutes for 200 customers.
        </p>
      )}
      {result && (
        <div className="text-xs">
          <span className="text-emerald-700">✓ {result.succeeded} succeeded</span>
          {result.failed > 0 && <span className="text-bad ml-2">⚠ {result.failed} still failing</span>}
        </div>
      )}
      {error && <div className="text-xs text-bad">{error}</div>}
    </div>
  );
}
