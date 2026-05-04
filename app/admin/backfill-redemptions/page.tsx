'use client';

import { useState } from 'react';
import Link from 'next/link';

interface ProcessedOrder {
  order_id: string;
  order_name: string;
  email: string | null;
  gift_card_amount: number;
  order_total: number;
  status: 'redeemed' | 'already_processed' | 'no_customer' | 'no_gift_card_txn' | 'error';
  detail?: string;
}

interface BackfillResult {
  ok: boolean;
  since: string;
  until: string | null;
  orders_fetched: number;
  orders_with_gift_card_txns: number;
  orders_redeemed: number;
  orders_already_processed: number;
  orders_no_customer: number;
  orders_errored: number;
  total_redeemed_amount: number;
  duration_ms: number;
  processed: ProcessedOrder[];
}

function defaultSince(): string {
  // Default: 30 days ago, formatted YYYY-MM-DD
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function BackfillRedemptionsPage() {
  const [since, setSince] = useState<string>(defaultSince());
  const [until, setUntil] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!since) {
      setError('Pick a "since" date');
      return;
    }
    setBusy(true); setResult(null); setError(null);
    try {
      const res = await fetch('/api/admin/backfill-redemptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since, until: until || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setResult(json as BackfillResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const filteredFailed = result?.processed.filter((p) => p.status === 'error' || p.status === 'no_customer') ?? [];
  const filteredRedeemed = result?.processed.filter((p) => p.status === 'redeemed') ?? [];

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Backfill redemptions from Shopify</h1>
      <p className="text-sm text-muted mb-6">
        Pulls paid Shopify orders in the date range, finds <code>gift_card</code> transactions,
        and runs each through the same redemption logic the live <code>orders/paid</code> webhook uses.
        Updates customer balances, writes ledger entries, populates revenue attribution. Idempotent — already-processed orders are skipped.
      </p>
      <p className="text-xs text-muted mb-6">
        Use this when the webhook didn&apos;t fire (or hasn&apos;t been configured yet) and customer balances
        in our DB are out of sync with their Shopify gift card redemptions.
      </p>

      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Since (orders created on/after)</span>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              disabled={busy}
              className="mt-1 block w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Until (optional)</span>
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              disabled={busy}
              className="mt-1 block w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink"
              placeholder="leave blank for now"
            />
          </label>
        </div>

        <button
          onClick={run}
          disabled={busy || !since}
          className="mt-4 bg-ink text-white px-5 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Run backfill'}
        </button>
        {busy && (
          <p className="text-xs text-muted mt-2">
            Pulls orders from Shopify REST API page-by-page, then fetches each order&apos;s transactions.
            Can take 30s+ depending on order volume — please don&apos;t close this tab.
          </p>
        )}
      </section>

      {error && (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad mb-6 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="border border-emerald-200 rounded-xl bg-emerald-50 p-6 mb-6">
            <h2 className="font-bold text-emerald-800 mb-3">
              Backfill complete in {(result.duration_ms / 1000).toFixed(1)}s
            </h2>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Row label="Orders fetched" value={result.orders_fetched.toLocaleString()} />
              <Row label="Orders with gift_card txns" value={result.orders_with_gift_card_txns.toLocaleString()} />
              <Row label="Redeemed this run" value={result.orders_redeemed.toLocaleString()} />
              <Row label="Already processed (skipped)" value={result.orders_already_processed.toLocaleString()} />
              <Row label="Customer not found" value={result.orders_no_customer.toLocaleString()} />
              <Row label="Errored" value={result.orders_errored.toLocaleString()} />
              <Row label="Total redeemed amount" value={`$${result.total_redeemed_amount.toFixed(2)}`} />
            </dl>
          </section>

          {filteredRedeemed.length > 0 && (
            <details className="border border-line rounded-xl bg-white p-4 mb-6" open>
              <summary className="cursor-pointer font-semibold">
                Redeemed orders ({filteredRedeemed.length})
              </summary>
              <table className="w-full text-sm mt-3">
                <thead>
                  <tr className="text-left text-muted border-b border-line">
                    <th className="py-2 font-medium">Order</th>
                    <th className="py-2 font-medium">Customer</th>
                    <th className="py-2 font-medium text-right">Gift card $</th>
                    <th className="py-2 font-medium text-right">Order $</th>
                    <th className="py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRedeemed.map((p, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="py-1.5 text-xs">{p.order_name}</td>
                      <td className="py-1.5 text-xs">{p.email ?? '—'}</td>
                      <td className="py-1.5 text-right font-mono text-xs">${p.gift_card_amount.toFixed(2)}</td>
                      <td className="py-1.5 text-right font-mono text-xs">${p.order_total.toFixed(2)}</td>
                      <td className="py-1.5 text-xs text-muted">{p.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {filteredFailed.length > 0 && (
            <details className="border border-bad rounded-xl bg-red-50 p-4 mb-6" open>
              <summary className="cursor-pointer font-semibold text-bad">
                Issues ({filteredFailed.length})
              </summary>
              <ul className="text-sm mt-3 space-y-1">
                {filteredFailed.map((p, i) => (
                  <li key={i} className="text-bad text-xs">
                    <strong>{p.order_name}</strong> ({p.email ?? 'no email'}) · {p.status}
                    {p.detail && ` · ${p.detail}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
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
