import { notFound, redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireMember } from '@/lib/auth';
import { InvoiceEditor } from '../invoice-editor';
import { type InvoiceData, DEFAULT_BILL_TO, DEFAULT_REMIT_TO } from '../types';

export const dynamic = 'force-dynamic';

/**
 * "Generate invoice" entry point. Pre-populates a draft invoice from the event:
 *   - one line item (event name × event total at 25% discount, matching the
 *     historical NADGT pattern)
 *   - bill-to: NADGT
 *   - remit-to: DiscHub
 *   - payment terms: Net 10
 *
 * The user can edit everything before saving. Saving creates the row in DB.
 */

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function NewInvoicePage({ params }: { params: { id: string } }) {
  await requireMember();
  const supabase = createSupabaseServerClient();

  const { data: event } = await supabase
    .from('events')
    .select('id, name, total_grants_amount, total_grants_count, event_date')
    .eq('id', params.id)
    .maybeSingle();
  if (!event) return notFound();

  // Reuse a draft invoice for this event if one already exists, so re-clicking
  // "Generate invoice" doesn't keep stacking up unsaved drafts.
  const { data: existingDraft } = await supabase
    .from('invoices')
    .select('id')
    .eq('event_id', params.id)
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingDraft) {
    redirect(`/events/${params.id}/invoice/${existingDraft.id}`);
  }

  const today = todayIso();
  const totalAmount = Number(event.total_grants_amount ?? 0);
  const draft: InvoiceData = {
    id: null,
    event_id: params.id,
    event_name: event.name ?? null,
    invoice_number: null,           // filled in once user saves
    invoice_date: today,
    due_date: addDays(today, 10),
    payment_terms: 'Net 10',

    bill_to_name: DEFAULT_BILL_TO.name,
    bill_to_address: DEFAULT_BILL_TO.address,

    remit_to_name: DEFAULT_REMIT_TO.name,
    remit_to_address: DEFAULT_REMIT_TO.address,

    line_items: [
      {
        description: event.name ?? 'Event credits',
        amount: Math.round(totalAmount * 100) / 100,
        discount_pct: 25,
      },
    ],
    notes: null,
    status: 'draft',
    paid_at: null,
  };

  return <InvoiceEditor initial={draft} eventId={params.id} />;
}
