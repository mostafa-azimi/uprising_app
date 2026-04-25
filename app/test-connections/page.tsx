'use client';

import { useState } from 'react';
import Link from 'next/link';

interface CheckResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

interface Results {
  supabase?: CheckResult;
  shopify?: CheckResult;
  klaviyo?: CheckResult;
}

export default function TestConnectionsPage() {
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setTopError(null);
    setResults(null);
    try {
      const res = await fetch('/api/test-connections', { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setTopError(j.error || `${res.status} ${res.statusText}`);
        return;
      }
      setResults(await res.json());
    } catch (e) {
      setTopError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Test connections</h1>
      <p className="text-sm text-muted mb-8">
        Verifies the app can reach Supabase, Shopify, and Klaviyo using the env vars set in Vercel (or <code>.env.local</code> locally).
      </p>

      <button
        onClick={run}
        disabled={loading}
        className="bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50 mb-6"
      >
        {loading ? 'Running…' : 'Run checks'}
      </button>

      {topError && (
        <div className="mb-6 p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad">
          {topError}
        </div>
      )}

      {results && (
        <div className="space-y-3">
          <Row label="Supabase" r={results.supabase} />
          <Row label="Shopify"  r={results.shopify} />
          <Row label="Klaviyo"  r={results.klaviyo} />
        </div>
      )}
    </main>
  );
}

function Row({ label, r }: { label: string; r?: CheckResult }) {
  if (!r) return null;
  return (
    <div className={`p-4 rounded-lg border bg-white flex items-start gap-3 ${r.ok ? 'border-line' : 'border-bad'}`}>
      <span className={`mt-0.5 inline-block w-2.5 h-2.5 rounded-full ${r.ok ? 'bg-ok' : 'bg-bad'}`} />
      <div className="flex-1">
        <div className="font-semibold">{label} {r.ok ? '✓' : '✗'}</div>
        <div className="text-sm text-muted mt-0.5">{r.ok ? r.detail : r.error}</div>
      </div>
    </div>
  );
}
