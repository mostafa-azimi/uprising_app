import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireMember } from '@/lib/auth';
import { InvoiceEditor } from '../invoice-editor';
import { type InvoiceData, type LineItem } from '../types';

export const dynamic = 'force-dynamic';

/**
 * Existing invoice: load from DB and hand off to the same editor used for new
 * drafts. The editor renders read-only labels (paid_at, invoice number, etc.)
 * automatically when status === 'paid' or the row already has an id.
 */

export default async function ExistingInvoicePage({
  params,
}: {
  params: { id: string; invoiceId: string };
}) {
  await requireMember();
  const supabase = createSupabaseServerClient();

  const [{ data: invoice }, { data: event }] = await Promise.all([
    supabase.from('invoices').select('*').eq('id', params.invoiceId).maybeSingle(),
    supabase.from('events').select('id, name').eq('id', params.id).maybeSingle(),
  ]);
  if (!invoice) return notFound();

  const items: LineItem[] = Array.isArray(invoice.line_items)
    ? (invoice.line_items as LineItem[])
    : [];
  const validStatuses = ['draft', 'sent', 'paid', 'void'] as const;
  type InvoiceStatus = (typeof validStatuses)[number];
  const status: InvoiceStatus = (validStatuses as readonly string[]).includes(invoice.status)
    ? (invoice.status as InvoiceStatus)
    : 'draft';

  const data: InvoiceData = {
    id: invoice.id,
    event_id: invoice.event_id,
    event_name: event?.name ?? null,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    due_date: invoice.due_date,
    payment_terms: invoice.payment_terms,
    bill_to_name: invoice.bill_to_name ?? '',
    bill_to_address: invoice.bill_to_address ?? '',
    remit_to_name: invoice.remit_to_name ?? '',
    remit_to_address: invoice.remit_to_address ?? '',
    line_items: items,
    invoice_discount_pct: Number(invoice.invoice_discount_pct ?? 0),
    notes: invoice.notes,
    status,
    paid_at: invoice.paid_at,
  };

  return <InvoiceEditor initial={data} eventId={params.id} />;
}
