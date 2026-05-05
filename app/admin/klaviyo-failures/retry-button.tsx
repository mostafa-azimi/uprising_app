'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RetryButton({ customerId, email }: { customerId: string; email: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'ok' | 'fail' | null>(null);
  const [detail, setDetail] = useState<string>('');
  const router = useRouter();

  async function handleRetry() {
    setBusy(true);
    setResult(null);
    setDetail('');
    try {
      const res = await fetch('/api/admin/klaviyo-failures/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_ids: [customerId] }),
      });
      const json = await res.json();
      if (!res.ok) {
        setResult('fail');
        setDetail(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const outcome = json.outcomes?.[0];
      if (outcome?.ok) {
        setResult('ok');
        setDetail(`Succeeded after ${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}`);
        // Refresh the page so the row drops off the list
        setTimeout(() => router.refresh(), 800);
      } else {
        setResult('fail');
        setDetail(outcome?.error ?? 'Retry failed');
      }
    } catch (e) {
      setResult('fail');
      setDetail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result === 'ok') {
    return (
      <span className="inline-block px-2 py-1 rounded text-xs bg-emerald-50 text-emerald-700 border border-emerald-200">
        ✓ {detail}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 justify-end">
      {result === 'fail' && (
        <span className="text-xs text-bad" title={detail}>Failed: {detail.slice(0, 40)}…</span>
      )}
      <button
        type="button"
        onClick={handleRetry}
        disabled={busy}
        className="bg-ink text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-50"
        title={`Retry Klaviyo push for ${email}`}
      >
        {busy ? 'Retrying…' : 'Retry now'}
      </button>
    </div>
  );
}
