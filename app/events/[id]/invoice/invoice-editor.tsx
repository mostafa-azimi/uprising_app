'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { downloadInvoicePdf } from './pdf';

/**
 * Invoice editor — single screen with:
 *   - Edit form on the left (bill-to / remit-to / dates / line items)
 *   - Live preview on the right that mirrors the PDF layout
 *
 * Save persists to DB. Download PDF generates a real .pdf file (jsPDF, no
 * print-dialog roundtrip). Mark paid sets status + paid_at.
 *
 * Line item amounts can be NEGATIVE — that's how we add credits/refunds that
 * reduce the invoice total.
 */

export const DEFAULT_BILL_TO = {
  name: 'NADGT',
  address: '3061 N Columbia St Suite D\nMilledgeville, GA 31061',
};

export const DEFAULT_REMIT_TO = {
  name: 'DiscHub',
  address: '3061 N Columbia St Suite D\nMilledgeville, GA 31061',
};

export interface LineItem {
  description: string;
  amount: number;
  discount_pct: number;
}

export interface InvoiceData {
  id: string | null;
  event_id: string | null;
  event_name: string | null;
  invoice_number: string | null;
  invoice_date: string;             // YYYY-MM-DD
  due_date: string | null;
  payment_terms: string | null;
  bill_to_name: string;
  bill_to_address: string;
  remit_to_name: string;
  remit_to_address: string;
  line_items: LineItem[];
  notes: string | null;
  status: 'draft' | 'sent' | 'paid' | 'void';
  paid_at: string | null;
}

function fmtMoney(n: number) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtDateLong(iso: string | null): string {
  if (!iso) return '—';
  // Avoid timezone shift: parse YYYY-MM-DD as a local date, not UTC.
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function lineTotal(li: LineItem): number {
  const discount = Math.max(0, Math.min(100, Number(li.discount_pct) || 0));
  const amt = Number(li.amount) || 0;
  return Math.round(amt * (1 - discount / 100) * 100) / 100;
}

export function InvoiceEditor({ initial, eventId }: { initial: InvoiceData; eventId: string }) {
  const router = useRouter();
  const [data, setData] = useState<InvoiceData>(initial);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const subtotal = useMemo(() => {
    return data.line_items.reduce((s, li) => s + lineTotal(li), 0);
  }, [data.line_items]);
  const total = subtotal;

  const isPaid = data.status === 'paid';
  const readOnly = isPaid;

  function patch<K extends keyof InvoiceData>(k: K, v: InvoiceData[K]) {
    setData((prev) => ({ ...prev, [k]: v }));
  }

  function patchLine(idx: number, patch: Partial<LineItem>) {
    setData((prev) => ({
      ...prev,
      line_items: prev.line_items.map((li, i) => (i === idx ? { ...li, ...patch } : li)),
    }));
  }

  function addLine() {
    setData((prev) => ({
      ...prev,
      line_items: [...prev.line_items, { description: '', amount: 0, discount_pct: 0 }],
    }));
  }

  function removeLine(idx: number) {
    setData((prev) => ({
      ...prev,
      line_items: prev.line_items.filter((_, i) => i !== idx),
    }));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const res = await fetch('/api/invoices/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...data,
          subtotal: Math.round(subtotal * 100) / 100,
          total: Math.round(total * 100) / 100,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSavedNote(`Saved ${body.invoice_number}`);
      // If we just promoted from draft (no id) to a real row, swap into the
      // permanent URL so refresh + back-button work.
      if (!data.id && body.id) {
        router.replace(`/events/${eventId}/invoice/${body.id}`);
      }
      setData((prev) => ({
        ...prev,
        id: body.id,
        invoice_number: body.invoice_number,
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkPaid() {
    if (marking) return;
    if (!data.id) {
      // Save first so we have an id.
      await handleSave();
    }
    if (!data.id && !savedNote) {
      // Save failed.
      return;
    }

    setMarking(true);
    setError(null);
    try {
      const res = await fetch('/api/invoices/mark-paid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: data.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData((prev) => ({ ...prev, status: 'paid', paid_at: body.paid_at }));
      setSavedNote('Marked paid');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMarking(false);
    }
  }

  function handleDownload() {
    downloadInvoicePdf({
      ...data,
      subtotal: Math.round(subtotal * 100) / 100,
      total: Math.round(total * 100) / 100,
    });
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-7xl mx-auto">
      <Link href={`/events/${eventId}`} className="text-sm text-muted hover:text-ink">
        ← Back to event
      </Link>

      <div className="mt-2 mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">
            Invoice {data.invoice_number ?? <span className="text-muted">(draft)</span>}
          </h1>
          {data.event_name && (
            <p className="text-sm text-muted mt-1">For event: {data.event_name}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {savedNote && <span className="text-xs text-emerald-600 mr-2">{savedNote}</span>}
          {error && <span className="text-xs text-bad mr-2">{error}</span>}
          <button
            onClick={handleDownload}
            className="px-3 py-2 text-sm border border-line rounded-lg bg-white hover:border-ink transition"
          >
            Download PDF
          </button>
          {!isPaid && (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-2 text-sm bg-ink text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50"
              >
                {saving ? 'Saving…' : data.id ? 'Save changes' : 'Save invoice'}
              </button>
              <button
                onClick={handleMarkPaid}
                disabled={marking || saving}
                className="px-3 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition disabled:opacity-50"
              >
                {marking ? 'Marking…' : 'Mark paid'}
              </button>
            </>
          )}
          {isPaid && data.paid_at && (
            <span className="px-3 py-2 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg">
              Paid {fmtDateLong(data.paid_at.slice(0, 10))}
            </span>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* LEFT: edit form */}
        <section className="space-y-6">
          <div className="border border-line rounded-xl bg-white p-5 space-y-4">
            <h2 className="font-semibold">Dates & terms</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Invoice date">
                <input
                  type="date"
                  value={data.invoice_date}
                  onChange={(e) => patch('invoice_date', e.target.value)}
                  disabled={readOnly}
                  className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
                />
              </Field>
              <Field label="Due date">
                <input
                  type="date"
                  value={data.due_date ?? ''}
                  onChange={(e) => patch('due_date', e.target.value || null)}
                  disabled={readOnly}
                  className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
                />
              </Field>
              <Field label="Payment terms" full>
                <input
                  type="text"
                  value={data.payment_terms ?? ''}
                  onChange={(e) => patch('payment_terms', e.target.value)}
                  disabled={readOnly}
                  placeholder="Net 10"
                  className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
                />
              </Field>
            </div>
          </div>

          <div className="border border-line rounded-xl bg-white p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Bill to</h2>
              <button
                type="button"
                onClick={() => {
                  patch('bill_to_name', DEFAULT_BILL_TO.name);
                  patch('bill_to_address', DEFAULT_BILL_TO.address);
                }}
                disabled={readOnly}
                className="text-xs text-muted hover:text-ink disabled:opacity-50"
              >
                Reset to NADGT
              </button>
            </div>
            <Field label="Name">
              <input
                type="text"
                value={data.bill_to_name}
                onChange={(e) => patch('bill_to_name', e.target.value)}
                disabled={readOnly}
                className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
              />
            </Field>
            <Field label="Address">
              <textarea
                value={data.bill_to_address}
                onChange={(e) => patch('bill_to_address', e.target.value)}
                disabled={readOnly}
                rows={3}
                className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
              />
            </Field>
          </div>

          <div className="border border-line rounded-xl bg-white p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Remit to</h2>
              <button
                type="button"
                onClick={() => {
                  patch('remit_to_name', DEFAULT_REMIT_TO.name);
                  patch('remit_to_address', DEFAULT_REMIT_TO.address);
                }}
                disabled={readOnly}
                className="text-xs text-muted hover:text-ink disabled:opacity-50"
              >
                Reset to DiscHub
              </button>
            </div>
            <Field label="Name">
              <input
                type="text"
                value={data.remit_to_name}
                onChange={(e) => patch('remit_to_name', e.target.value)}
                disabled={readOnly}
                className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
              />
            </Field>
            <Field label="Address">
              <textarea
                value={data.remit_to_address}
                onChange={(e) => patch('remit_to_address', e.target.value)}
                disabled={readOnly}
                rows={3}
                className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
              />
            </Field>
          </div>

          <div className="border border-line rounded-xl bg-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Line items</h2>
              {!readOnly && (
                <button
                  type="button"
                  onClick={addLine}
                  className="text-xs text-ink hover:underline"
                >
                  + Add line
                </button>
              )}
            </div>
            <p className="text-xs text-muted mb-3">
              Amounts can be negative to credit/reduce the invoice.
            </p>
            <div className="space-y-3">
              {data.line_items.map((li, idx) => (
                <div key={idx} className="border border-line rounded-lg p-3 bg-slate-50/40">
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-12 sm:col-span-6">
                      <label className="text-xs text-muted">Description</label>
                      <input
                        type="text"
                        value={li.description}
                        onChange={(e) => patchLine(idx, { description: e.target.value })}
                        disabled={readOnly}
                        className="w-full px-2 py-1 border border-line rounded text-sm disabled:bg-slate-100"
                      />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <label className="text-xs text-muted">Amount</label>
                      <input
                        type="number"
                        step="0.01"
                        value={Number.isFinite(li.amount) ? li.amount : 0}
                        onChange={(e) =>
                          patchLine(idx, { amount: parseFloat(e.target.value) || 0 })
                        }
                        disabled={readOnly}
                        className="w-full px-2 py-1 border border-line rounded text-sm disabled:bg-slate-100"
                      />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <label className="text-xs text-muted">Discount %</label>
                      <input
                        type="number"
                        step="1"
                        min={0}
                        max={100}
                        value={Number.isFinite(li.discount_pct) ? li.discount_pct : 0}
                        onChange={(e) =>
                          patchLine(idx, { discount_pct: parseFloat(e.target.value) || 0 })
                        }
                        disabled={readOnly}
                        className="w-full px-2 py-1 border border-line rounded text-sm disabled:bg-slate-100"
                      />
                    </div>
                    <div className="col-span-4 sm:col-span-2 flex items-end justify-between gap-2">
                      <div>
                        <div className="text-xs text-muted">Total</div>
                        <div className="text-sm font-semibold">{fmtMoney(lineTotal(li))}</div>
                      </div>
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className="text-xs text-bad hover:underline self-end"
                          title="Remove line"
                        >
                          remove
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {data.line_items.length === 0 && (
                <div className="text-sm text-muted text-center py-4">No lines yet.</div>
              )}
            </div>
          </div>

          <div className="border border-line rounded-xl bg-white p-5">
            <h2 className="font-semibold mb-2">Notes</h2>
            <textarea
              value={data.notes ?? ''}
              onChange={(e) => patch('notes', e.target.value || null)}
              disabled={readOnly}
              rows={3}
              placeholder="Internal notes (not shown on the invoice PDF)"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm disabled:bg-slate-50"
            />
          </div>
        </section>

        {/* RIGHT: live preview matching the PDF */}
        <section className="lg:sticky lg:top-6 self-start">
          <InvoicePreview data={data} subtotal={subtotal} total={total} />
        </section>
      </div>
    </main>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <label className="text-xs text-muted block mb-1">{label}</label>
      {children}
    </div>
  );
}

function InvoicePreview({
  data,
  subtotal,
  total,
}: {
  data: InvoiceData;
  subtotal: number;
  total: number;
}) {
  return (
    <div className="border border-line rounded-xl overflow-hidden shadow-sm bg-white">
      {/* Header band */}
      <div className="bg-[#0F1F3A] text-white px-8 py-6 flex items-start justify-between">
        <div>
          <div className="text-2xl font-bold tracking-tight">DiscHub</div>
          <div className="text-xs opacity-80 mt-2 whitespace-pre-line leading-snug">
            {DEFAULT_REMIT_TO.address}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-widest opacity-80">Invoice</div>
          <div className="text-xl font-semibold mt-1">
            {data.invoice_number ?? '(draft)'}
          </div>
        </div>
      </div>

      <div className="px-8 py-6 text-sm">
        <div className="grid grid-cols-2 gap-6 mb-6">
          <div>
            <div className="text-xs uppercase text-muted tracking-widest mb-1">Invoice date</div>
            <div>{fmtDateLong(data.invoice_date)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted tracking-widest mb-1">Due</div>
            <div>
              {fmtDateLong(data.due_date)}
              {data.payment_terms ? <span className="text-muted"> · {data.payment_terms}</span> : null}
            </div>
          </div>
        </div>

        <div className="mb-6">
          <div className="text-xs uppercase text-muted tracking-widest mb-1">Bill to</div>
          <div className="font-semibold">{data.bill_to_name}</div>
          <div className="whitespace-pre-line text-muted">{data.bill_to_address}</div>
        </div>

        <table className="w-full text-sm border-t border-line">
          <thead>
            <tr className="text-left text-muted border-b border-line">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 font-medium text-right">Amount</th>
              <th className="py-2 font-medium text-right">Discount</th>
              <th className="py-2 font-medium text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {data.line_items.map((li, idx) => (
              <tr key={idx} className="border-b border-line/50">
                <td className="py-2">{li.description || <span className="text-muted">—</span>}</td>
                <td className="py-2 text-right">{fmtMoney(li.amount)}</td>
                <td className="py-2 text-right">
                  {li.discount_pct ? `${li.discount_pct}%` : '—'}
                </td>
                <td className="py-2 text-right font-semibold">{fmtMoney(lineTotal(li))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-end mt-4">
          <div className="w-64 space-y-1">
            <div className="flex justify-between text-sm">
              <div className="text-muted">Subtotal</div>
              <div>{fmtMoney(subtotal)}</div>
            </div>
            <div className="flex justify-between text-base font-semibold border-t border-line pt-1">
              <div>Total</div>
              <div>{fmtMoney(total)}</div>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-line">
          <div className="text-xs uppercase text-muted tracking-widest mb-1">Remit to</div>
          <div className="font-semibold">{data.remit_to_name}</div>
          <div className="whitespace-pre-line text-muted">{data.remit_to_address}</div>
        </div>

        <div className="mt-6 text-center text-sm italic text-muted">
          Thank you for your business!
        </div>
      </div>
    </div>
  );
}
