'use client';

import { useState } from 'react';
import Link from 'next/link';

interface ProcessedOrder {
  order_id: string;
  order_name: string;
  email: string | null;
  gift_card_amount: number;
  order_total: number;
  other_amount: number;
  event_id: string | null;
  event_name: string | null;
  status: 'attributed' | 'no_event_match' | 'no_customer' | 'no_gift_card_txn' | 'error';
  detail?: string;
}

interface AttributeResult {
  ok: boolean;
  since: string;
  until: string | null;
  orders_fetched: number;
  orders_with_gift_card_txns: number;
  orders_attributed: number;
  orders_no_event_match: number;
  orders_no_customer: number;
  orders_errored: number;
  total_attributed_gift_card: number;
  total_attributed_revenue: number;
  duration_ms: number;
  processed: ProcessedOrder[];
}

function defaultSince(): string {
  // Default: 7 days ago, formatted YYYY-MM-DD
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function fmtMoney(n: number) {
  return `$${n.toFixed(2)}`;
}

export default function AttributeOrdersPage() {
  const [since, setSince] = useState<string>(defaultSince());
  const [until, setUntil] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AttributeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!since) {
      setError('Pick a "since" date');
      return;
    }
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/attribute-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since, until: until || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setResult(json as AttributeResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-4xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Attribute orders to events</h1>
      <p className="text-sm text-muted mb-3">
        Pulls paid Shopify orders in the date range, finds their <code>gift_card</code> transactions,
        and links each order to the event whose grant the customer used. Updates <code>redemption_orders</code> only.
      </p>
      <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 rounded-lg p-3 text-sm mb-6">
        <strong>Read-only for loyalty:</strong> this tool will NOT change gift card balances, ledger entries,
        Klaviyo profiles, or anything in Shopify. It only writes attribution snapshots that show up on event detail pages.
      </div>

      <div className="bg-white border border-line rounded-xl p-5 space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <div className="text-xs text-muted mb-1">Since (required)</div>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded-lg text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Until (optional, defaults to now)</div>
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded-lg text-sm"
            />
          </label>
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="px-4 py-2 bg-ink text-white text-sm rounded-lg hover:bg-slate-800 transition disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Attribute orders'}
        </button>
        {error && <div className="text-sm text-bad">{error}</div>}
      </div>

      {result && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold mb-3">
            Result
            <span className="ml-2 text-xs text-muted">{(result.duration_ms / 1000).toFixed(1)}s</span>
          </h2>
          <div className="grid sm:grid-cols-3 gap-3 mb-6">
            <Stat label="Orders fetched" value={String(result.orders_fetched)} />
            <Stat label="Attributed" value={String(result.orders_attributed)} />
            <Stat label="No event match" value={String(result.orders_no_event_match)} />
            <Stat label="No customer" value={String(result.orders_no_customer)} />
            <Stat label="Errored" value={String(result.orders_errored)} />
            <Stat label="With gift card txn" value={String(result.orders_with_gift_card_txns)} />
            <Stat label="Total gift card $" value={fmtMoney(result.total_attributed_gift_card)} />
            <Stat label="Total order $" value={fmtMoney(result.total_attributed_revenue)} />
          </div>

          <h3 className="font-semibold mb-2">Per-order detail</h3>
          <div className="border border-line rounded-xl bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted bg-slate-50 border-b border-line">
                  <th className="py-2 px-3 font-medium">Order</th>
                  <th className="py-2 px-3 font-medium">Email</th>
                  <th className="py-2 px-3 font-medium">Event</th>
                  <th className="py-2 px-3 font-medium text-right">Gift card</th>
                  <th className="py-2 px-3 font-medium text-right">Order total</th>
                  <th className="py-2 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.processed.map((p) => (
                  <tr key={p.order_id} className="border-b border-line last:border-0">
                    <td className="py-2 px-3">{p.order_name}</td>
                    <td className="py-2 px-3 text-xs text-muted">{p.email ?? '—'}</td>
                    <td className="py-2 px-3 text-xs">{p.event_name ?? '—'}</td>
                    <td className="py-2 px-3 text-right">{fmtMoney(p.gift_card_amount)}</td>
                    <td className="py-2 px-3 text-right">{fmtMoney(p.order_total)}</td>
                    <td className="py-2 px-3">
                      <StatusBadge status={p.status} detail={p.detail} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-lg border border-line bg-white">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
    </div>
  );
}

function StatusBadge({ status, detail }: { status: ProcessedOrder['status']; detail?: string }) {
  const styles: Record<ProcessedOrder['status'], string> = {
    attributed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    no_event_match: 'bg-amber-50 text-amber-700 border-amber-200',
    no_customer: 'bg-amber-50 text-amber-700 border-amber-200',
    no_gift_card_txn: 'bg-slate-100 text-slate-600 border-slate-200',
    error: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs border rounded-full ${styles[status]}`}
      title={detail}
    >
      {status}
    </span>
  );
}
