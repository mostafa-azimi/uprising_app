'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function AutoExpireToggle({
  initialEnabled,
  updatedAt,
  updatedByEmail,
}: {
  initialEnabled: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function flip(target: boolean) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/admin/settings/auto-expire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: target }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setEnabled(target);
      setSuccess(target ? 'Auto-expire ENABLED. Daily cron will run at 7:00 UTC.' : 'Auto-expire DISABLED. Daily cron will skip until re-enabled.');
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-sm">
          Auto-expire daily cron:{' '}
          <strong className={enabled ? 'text-emerald-700' : 'text-bad'}>
            {enabled ? 'ENABLED' : 'DISABLED'}
          </strong>
        </span>
        <button
          onClick={() => flip(!enabled)}
          disabled={busy}
          role="switch"
          aria-checked={enabled}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:opacity-50 ${
            enabled ? 'bg-emerald-500' : 'bg-slate-300'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <p className="text-xs text-muted">
        When disabled, the daily cron at 7:00 UTC (3am ET) skips silently. The manual sweep button below still works regardless.
      </p>
      {updatedAt && (
        <p className="text-xs text-muted italic">
          Last changed {new Date(updatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short', timeZoneName: 'short' })}{updatedByEmail ? ` by ${updatedByEmail}` : ''}.
        </p>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {success && <p className="text-sm text-ok">{success}</p>}
    </div>
  );
}
