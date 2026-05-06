/**
 * Plain (no 'use client') module that holds the invoice data shapes and the
 * default bill-to / remit-to addresses. Server Components import from here so
 * Next.js doesn't have to thread these through the React Client Manifest.
 */

export interface LineItem {
  description: string;
  /** Quantity, defaults to 1 for legacy rows that didn't store it */
  quantity: number;
  /** Unit price; for legacy rows we backfill this from `amount` */
  unit_price: number;
  /** Subtotal before line discount (= quantity × unit_price). Stored for
   *  backwards compatibility with older rows that only had `amount`. */
  amount: number;
  discount_pct: number;
}

/**
 * Older invoices were stored with only { description, amount, discount_pct }.
 * Coerce them into the qty/unit_price shape so the editor can display them.
 */
export function normalizeLineItem(raw: Partial<LineItem> & Record<string, unknown>): LineItem {
  const description = typeof raw.description === 'string' ? raw.description : '';
  const discount_pct = Number(raw.discount_pct ?? 0) || 0;

  const rawQty = raw.quantity;
  const rawUnit = raw.unit_price;
  const rawAmount = raw.amount;

  let quantity = Number(rawQty);
  let unit_price = Number(rawUnit);

  if (!Number.isFinite(quantity) || quantity === 0) quantity = 1;
  if (!Number.isFinite(unit_price)) {
    // Legacy rows: amount IS the subtotal, so unit_price = amount / 1 = amount
    unit_price = Number(rawAmount ?? 0) || 0;
  }

  const amount = Math.round(quantity * unit_price * 100) / 100;
  return { description, quantity, unit_price, amount, discount_pct };
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
  /** Whole-invoice discount applied AFTER per-line discounts. 0–100. */
  invoice_discount_pct: number;
  notes: string | null;
  status: 'draft' | 'sent' | 'paid' | 'void';
  paid_at: string | null;
}

export const DEFAULT_BILL_TO = {
  name: 'NADGT',
  address: '3061 N Columbia St Suite D\nMilledgeville, GA 31061',
};

export const DEFAULT_REMIT_TO = {
  name: 'DiscHub',
  address: '3061 N Columbia St Suite D\nMilledgeville, GA 31061',
};

export function lineTotal(li: LineItem): number {
  const discount = Math.max(0, Math.min(100, Number(li.discount_pct) || 0));
  // Prefer qty × unit_price; fall back to legacy `amount` field.
  const qty = Number(li.quantity);
  const unit = Number(li.unit_price);
  const subtotal =
    Number.isFinite(qty) && Number.isFinite(unit) && (qty !== 0 || unit !== 0)
      ? qty * unit
      : Number(li.amount) || 0;
  return Math.round(subtotal * (1 - discount / 100) * 100) / 100;
}

export function lineSubtotal(li: LineItem): number {
  const qty = Number(li.quantity);
  const unit = Number(li.unit_price);
  if (Number.isFinite(qty) && Number.isFinite(unit)) return Math.round(qty * unit * 100) / 100;
  return Number(li.amount) || 0;
}

/**
 * Compute the invoice subtotal (sum of line totals) and final total
 * (subtotal * (1 - invoice_discount_pct/100)).
 */
export function computeTotals(
  lines: LineItem[],
  invoiceDiscountPct: number
): { subtotal: number; invoiceDiscountAmount: number; total: number } {
  const subtotal = Math.round(lines.reduce((s, li) => s + lineTotal(li), 0) * 100) / 100;
  const pct = Math.max(0, Math.min(100, Number(invoiceDiscountPct) || 0));
  const invoiceDiscountAmount = Math.round(subtotal * (pct / 100) * 100) / 100;
  const total = Math.round((subtotal - invoiceDiscountAmount) * 100) / 100;
  return { subtotal, invoiceDiscountAmount, total };
}
