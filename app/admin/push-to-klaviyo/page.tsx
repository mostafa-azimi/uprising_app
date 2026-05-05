'use client';

import { useState } from 'react';
import Link from 'next/link';

interface PreviewResult {
  ok: boolean;
  since: string;
  until: string | null;
  customer_count: number;
  customer_ids_sample: string[];
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

interface ApplyResult {
  ok: boolean;
  customers_attempted: number;
  succeeded: number;
  failed: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 16); // datetime-local
}

export default function PushToKlaviyoPage() {
  const [since, setSince] = useState<string>(defaultSince());
  const [until, setUntil] = useState<string>('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPreview() {
    setPreviewBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/push-to-klaviyo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          since: new Date(since).toISOString(),
          until: until ? new Date(until).toISOString() : undefined,
        }),
      });
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
    setApplyBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/push-to-klaviyo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'apply',
          since: new Date(since).toISOString(),
          until: until ? new Date(until).toISOString() : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setResult(json as ApplyResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Push customers to Klaviyo</h1>
      <p className="text-sm text-muted mb-2">
        Re-pushes the current DB state (loyalty_card_code, loyalty_card_balance, expiration_date) to
        Klaviyo for every customer that had a balance change in the date range.
      </p>
      <p className="text-xs text-muted mb-6">
        Use this after a Klaviyo outage or after manual SQL edits to flush our DB state to Klaviyo.
        Each customer goes through the 3-attempt retry helper. Anything that still fails lands on{' '}
        <Link href="/admin/klaviyo-failures" className="text-ink hover:underline">Klaviyo failures</Link>.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-3">Date range</h2>
        <div className="grid sm:grid-cols-2 gap-4 mb-4">
          <label className="block">
            <span className="text-sm font-medium">Since (ledger entries on/after)</span>
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              disabled={previewBusy || applyBusy}
              className="mt-1 block w-full border border-line rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Until (optional)</span>
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              disabled={previewBusy || applyBusy}
              className="mt-1 block w-full border border-line rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button
            onClick={runPreview}
            disabled={previewBusy || applyBusy || !since}
            className="bg-white border border-line px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {previewBusy ? 'Counting…' : 'Preview count'}
          </button>
          <button
            onClick={runApply}
            disabled={applyBusy || previewBusy || !since}
            className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {applyBusy ? 'Pushing…' : 'Push to Klaviyo'}
          </button>
        </div>

        {applyBusy && (
          <p className="text-xs text-muted mt-3">
            Up to 200 customers per click, concurrency 5, 3-retry per customer. Could take a few
            minutes if Klaviyo is slow. Don&apos;t close this tab.
          </p>
        )}
      </section>

      {error && (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {preview && (
        <section className="border border-line rounded-xl bg-white p-6 mb-6">
          <h2 className="font-bold mb-3">Preview</h2>
          <p className="text-sm">
            <strong>{preview.customer_count.toLocaleString()}</strong> distinct customer
            {preview.customer_count === 1 ? '' : 's'} had a ledger entry in this range.
          </p>
          {preview.customer_count > 200 && (
            <p className="text-xs text-amber-700 bg-yellow-50 border border-yellow-200 rounded-md px-3 py-2 mt-3">
              Each Push click handles up to 200. You&apos;ll need to click Push multiple times (or
              shrink the range) for all of them.
            </p>
          )}
        </section>
      )}

      {result && (
        <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
          <h2 className="font-bold text-emerald-800 mb-3">
            Push complete in {(result.duration_ms / 1000).toFixed(1)}s
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row label="Attempted" value={result.customers_attempted.toLocaleString()} />
            <Row label="Succeeded" value={result.succeeded.toLocaleString()} bold />
            <Row label="Failed (landed on failures page)" value={result.failed.toLocaleString()} bold />
          </dl>
          {result.failed > 0 && (
            <p className="text-xs text-muted mt-3">
              The failures will appear on the in-app banner and{' '}
              <Link href="/admin/klaviyo-failures" className="text-ink hover:underline">/admin/klaviyo-failures</Link>.
              When Klaviyo recovers, click Retry all there.
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`text-right ${bold ? 'font-bold' : 'font-semibold'}`}>{value}</dd>
    </>
  );
}
