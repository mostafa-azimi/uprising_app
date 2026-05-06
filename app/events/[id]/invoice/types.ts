/**
 * Plain (no 'use client') module that holds the invoice data shapes and the
 * default bill-to / remit-to addresses. Server Components import from here so
 * Next.js doesn't have to thread these through the React Client Manifest.
 */

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
  const amt = Number(li.amount) || 0;
  return Math.round(amt * (1 - discount / 100) * 100) / 100;
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
