'use client';

import { useState } from 'react';

export function ResyncButton({
  endpoint,
  label,
  pendingLabel = 'Resyncing…',
  description,
}: {
  endpoint: string;
  label: string;
  pendingLabel?: string;
  description: string;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; updated: number; errors: number } | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<unknown[]>([]);

  async function run() {
    setBusy(true);
    setError(null);
    setDone(false);
    setDetails([]);
    setProgress({ scanned: 0, updated: 0, errors: 0 });

    let offset = 0;
    let totalScanned = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    const accumulated: unknown[] = [];

    try {
      while (true) {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? `${res.status} ${res.statusText}`);
          break;
        }
        totalScanned += json.scanned ?? 0;
        totalUpdated += (json.drift_corrected ?? json.pushed ?? 0);
        totalErrors += json.errors ?? 0;
        if (json.details) accumulated.push(...json.details);
        setProgress({ scanned: totalScanned, updated: totalUpdated, errors: totalErrors });
        if (json.next_offset == null) break;
        offset = json.next_offset;
      }
      setDone(true);
      setDetails(accumulated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-sm text-muted mb-3">{description}</p>
      <button
        onClick={run}
        disabled={busy}
        className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {busy ? pendingLabel : label}
      </button>

      {progress && (
        <div className="mt-3 text-sm">
          Scanned <strong>{progress.scanned}</strong> · Updated <strong>{progress.updated}</strong>
          {progress.errors > 0 && <> · Errors <strong className="text-bad">{progress.errors}</strong></>}
          {!done && busy && <span className="text-muted ml-2">(in progress)</span>}
          {done && <span className="text-ok ml-2">✓ Done</span>}
        </div>
      )}

      {error && <pre className="mt-3 p-3 text-xs text-bad bg-red-50 border border-bad rounded-lg whitespace-pre-wrap">{error}</pre>}

      {done && details.length > 0 && (
        <details className="mt-3">
          <summary className="text-sm text-muted cursor-pointer">Details ({details.length} entries)</summary>
          <pre className="mt-2 p-3 text-xs bg-slate-50 border border-line rounded-lg max-h-96 overflow-auto">{JSON.stringify(details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
