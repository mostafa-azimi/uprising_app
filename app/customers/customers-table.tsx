'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CopyButton } from '@/components/copy-button';
import { expirationClass, expirationStatus } from '@/lib/dates';

interface Customer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  total_balance_cached: number;
  loyalty_card_code: string | null;
  shopify_gift_card_id: string | null;
  shopify_gift_card_last4: string | null;
  klaviyo_profile_id: string | null;
  expiration_date: string | null;
  created_at: string;
  updated_at: string;
}

function fmtRelative(iso: string | null | undefined) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const HEADERS: Array<{ key: string; label: string; sortable: boolean }> = [
  { key: '__select', label: '', sortable: false },
  { key: 'email', label: 'Customer', sortable: true },
  { key: 'balance', label: 'Balance', sortable: true },
  { key: '__grants', label: 'Active grants', sortable: false },
  { key: '__code', label: 'Loyalty code', sortable: false },
  { key: 'expiration', label: 'Expires', sortable: true },
  { key: 'activity', label: 'Last activity', sortable: true },
  { key: '__actions', label: '', sortable: false },
];

export function CustomersTable({
  customers, grantCounts, sortKey, dir, q, shopAdminBase,
}: {
  customers: Customer[];
  grantCounts: Record<string, { active: number; total: number }>;
  sortKey: string;
  dir: 'asc' | 'desc';
  q: string;
  shopAdminBase: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const allSelected = customers.length > 0 && selected.size === customers.length;
  const someSelected = selected.size > 0 && selected.size < customers.length;

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(customers.map((c) => c.id)));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function sortHref(headerKey: string) {
    if (!HEADERS.find((h) => h.key === headerKey)?.sortable) return null;
    // If clicking current sort column, flip direction. Else go to desc.
    const newDir = sortKey === headerKey && dir === 'desc' ? 'asc' : 'desc';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    params.set('sort', headerKey);
    params.set('dir', newDir);
    return `/customers?${params.toString()}`;
  }

  function sortIndicator(headerKey: string) {
    if (sortKey !== headerKey) return null;
    return dir === 'desc' ? ' ↓' : ' ↑';
  }

  function klaviyoLinkHref(c: Customer) {
    if (c.klaviyo_profile_id) {
      return `https://www.klaviyo.com/profile/${c.klaviyo_profile_id}`;
    }
    // Lazy lookup endpoint that fetches + saves the ID then redirects
    return `/api/customers/${c.id}/klaviyo-link`;
  }

  async function bulkExpire() {
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    setBusyMessage(`Expiring ${selected.size} customer${selected.size === 1 ? '' : 's'}…`);
    try {
      const res = await fetch('/api/customers/bulk-expire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: Array.from(selected) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setBusyMessage(null);
      setSelected(new Set());
      // Refresh the list
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Bulk action toolbar — only visible when something is selected */}
      {selected.size > 0 && (
        <div className="mb-3 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between text-sm">
          <span><strong>{selected.size}</strong> selected</span>
          <div className="flex gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-muted hover:text-ink px-2 py-1"
            >
              Clear
            </button>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={busy}
              className="bg-bad text-white px-3 py-1 rounded-md font-medium disabled:opacity-50"
            >
              Expire {selected.size} balance{selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 p-3 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error}</div>
      )}
      {busy && busyMessage && (
        <div className="mb-3 p-3 rounded-lg border border-line bg-slate-50 text-sm">{busyMessage}</div>
      )}

      <div className="border border-line rounded-xl bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted bg-slate-50 border-b border-line">
              {HEADERS.map((h) => {
                const href = sortHref(h.key);
                const indicator = sortIndicator(h.key);
                if (h.key === '__select') {
                  return (
                    <th key={h.key} className="py-2 px-4 w-10">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={toggleAll}
                        aria-label="Select all on this page"
                      />
                    </th>
                  );
                }
                return (
                  <th key={h.key} className="py-2 px-4 font-medium select-none">
                    {href ? (
                      <Link href={href} className="hover:text-ink inline-flex items-center">
                        {h.label}{indicator}
                      </Link>
                    ) : h.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => {
              const gc = grantCounts[c.id] ?? { active: 0, total: 0 };
              return (
                <tr key={c.id} className={`border-b border-line last:border-0 hover:bg-slate-50 ${selected.has(c.id) ? 'bg-amber-50' : ''}`}>
                  <td className="py-2 px-4">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      aria-label={`Select ${c.email}`}
                    />
                  </td>
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{c.email}</span>
                      <a
                        href={klaviyoLinkHref(c)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open in Klaviyo"
                        aria-label={`Open ${c.email} in Klaviyo`}
                        className="inline-flex items-center justify-center w-5 h-5 rounded border border-line bg-white text-xs text-muted hover:text-ink hover:border-ink"
                      >
                        ↗
                      </a>
                    </div>
                    <div className="text-xs text-muted">
                      {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                    </div>
                  </td>
                  <td className="py-2 px-4 font-semibold">
                    ${Number(c.total_balance_cached ?? 0).toFixed(2)}
                  </td>
                  <td className="py-2 px-4">
                    {gc.active}{gc.total > gc.active ? <span className="text-muted text-xs"> / {gc.total} total</span> : null}
                  </td>
                  <td className="py-2 px-4">
                    {c.loyalty_card_code ? (
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-muted">
                        {c.loyalty_card_code}
                        <CopyButton value={c.loyalty_card_code} />
                        {c.shopify_gift_card_id && (
                          <a
                            href={`${shopAdminBase}/gift_cards/${c.shopify_gift_card_id.split('/').pop()}`}
                            target="_blank"
                            rel="noreferrer"
                            title="Open this gift card in Shopify admin"
                            aria-label="Open gift card in Shopify"
                            className="inline-flex items-center justify-center w-5 h-5 rounded border border-line bg-white hover:text-ink hover:border-ink"
                          >
                            ↗
                          </a>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={`py-2 px-4 text-xs ${expirationClass(c.expiration_date)}`}
                      title={expirationStatus(c.expiration_date) === 'past' ? 'Expired' : expirationStatus(c.expiration_date) === 'soon' ? 'Expires within 30 days' : ''}>
                    {fmtDate(c.expiration_date)}
                  </td>
                  <td className="py-2 px-4 text-muted text-xs" title={c.updated_at}>
                    {fmtRelative(c.updated_at)}
                  </td>
                  <td className="py-2 px-4 text-right">
                    <Link href={`/customers/${c.id}`} className="text-ink underline">
                      Open →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Confirm modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h2 className="text-lg font-bold mb-2">Expire {selected.size} customer balance{selected.size === 1 ? '' : 's'}?</h2>
            <p className="text-sm text-muted mb-4">
              This will:
            </p>
            <ul className="text-sm text-muted list-disc pl-5 mb-5 space-y-1">
              <li>Debit each customer's Shopify gift card to <strong>$0</strong></li>
              <li>Mark all active grants as expired in our database</li>
              <li>Update each Klaviyo profile's <code>loyalty_card_balance</code> to <code>0</code></li>
              <li>Write ledger entries (audit trail)</li>
            </ul>
            <p className="text-sm font-semibold text-bad mb-5">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 rounded-lg text-sm border border-line hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={bulkExpire}
                className="px-4 py-2 rounded-lg text-sm bg-bad text-white font-medium hover:opacity-90"
              >
                Yes, expire {selected.size}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
