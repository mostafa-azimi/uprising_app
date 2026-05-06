import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireMember } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Upsert an invoice draft. If `id` is null, inserts a new row and lets Postgres
 * assign the next number from invoice_number_seq. If `id` is set, updates that
 * row in place — but never updates a row whose status is `paid` (locked).
 *
 * Subtotal/total are recomputed server-side from line_items so the client
 * cannot tamper with them.
 */

const LineItemSchema = z.object({
  description: z.string().max(500),
  // quantity / unit_price are optional for backwards compat with older drafts
  // that only tracked a single `amount`. We backfill them server-side below.
  quantity: z.number().finite().optional(),
  unit_price: z.number().finite().optional(),
  amount: z.number().finite(),
  discount_pct: z.number().min(0).max(100),
});

const Body = z.object({
  id: z.string().uuid().nullable(),
  event_id: z.string().uuid().nullable(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  payment_terms: z.string().max(100).nullable(),
  bill_to_name: z.string().max(200),
  bill_to_address: z.string().max(1000),
  remit_to_name: z.string().max(200),
  remit_to_address: z.string().max(1000),
  line_items: z.array(LineItemSchema).max(50),
  invoice_discount_pct: z.number().min(0).max(100).default(0),
  notes: z.string().max(2000).nullable(),
});

function deriveAmount(li: z.infer<typeof LineItemSchema>): number {
  // Prefer qty × unit_price; fall back to the explicit `amount` for legacy.
  if (typeof li.quantity === 'number' && typeof li.unit_price === 'number') {
    return Math.round(li.quantity * li.unit_price * 100) / 100;
  }
  return Math.round(li.amount * 100) / 100;
}

function lineTotal(li: z.infer<typeof LineItemSchema>): number {
  const discount = Math.max(0, Math.min(100, li.discount_pct));
  return Math.round(deriveAmount(li) * (1 - discount / 100) * 100) / 100;
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireMember();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    const json = await request.json();
    body = Body.parse(json);
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid request body: ${(e as Error).message}` },
      { status: 400 }
    );
  }

  // Round all monetary fields to 2 decimals up front so anything we store is
  // identical to what the PDF renders.
  const lineItems = body.line_items.map((li) => {
    const quantity =
      typeof li.quantity === 'number' && Number.isFinite(li.quantity) ? li.quantity : 1;
    const unitPrice =
      typeof li.unit_price === 'number' && Number.isFinite(li.unit_price)
        ? li.unit_price
        : Number(li.amount) || 0;
    const amount = Math.round(quantity * unitPrice * 100) / 100;
    return {
      description: li.description,
      quantity: Math.round(quantity * 100) / 100,
      unit_price: Math.round(unitPrice * 100) / 100,
      amount,
      discount_pct: Math.round(li.discount_pct * 100) / 100,
      line_total: lineTotal(li),
    };
  });
  const subtotal = Math.round(lineItems.reduce((s, li) => s + li.line_total, 0) * 100) / 100;
  const invoiceDiscountPct = Math.max(0, Math.min(100, body.invoice_discount_pct));
  const total = Math.round(subtotal * (1 - invoiceDiscountPct / 100) * 100) / 100;

  const supabase = createSupabaseServiceClient();

  if (body.id) {
    // Updating existing — make sure it's not paid.
    const { data: existing, error: e1 } = await supabase
      .from('invoices')
      .select('id, status')
      .eq('id', body.id)
      .maybeSingle();
    if (e1) {
      return NextResponse.json({ error: e1.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    if (existing.status === 'paid') {
      return NextResponse.json(
        { error: 'This invoice is paid and cannot be edited. Mark it void to revise.' },
        { status: 409 }
      );
    }

    const { data: updated, error: e2 } = await supabase
      .from('invoices')
      .update({
        event_id: body.event_id,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        payment_terms: body.payment_terms,
        bill_to_name: body.bill_to_name,
        bill_to_address: body.bill_to_address,
        remit_to_name: body.remit_to_name,
        remit_to_address: body.remit_to_address,
        line_items: lineItems,
        invoice_discount_pct: invoiceDiscountPct,
        subtotal,
        total,
        notes: body.notes,
      })
      .eq('id', body.id)
      .select('id, invoice_number, status')
      .maybeSingle();
    if (e2 || !updated) {
      return NextResponse.json(
        { error: e2?.message ?? 'Update failed' },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      id: updated.id,
      invoice_number: updated.invoice_number,
      status: updated.status,
    });
  }

  // Insert new
  const { data: inserted, error } = await supabase
    .from('invoices')
    .insert({
      event_id: body.event_id,
      invoice_date: body.invoice_date,
      due_date: body.due_date,
      payment_terms: body.payment_terms,
      bill_to_name: body.bill_to_name,
      bill_to_address: body.bill_to_address,
      remit_to_name: body.remit_to_name,
      remit_to_address: body.remit_to_address,
      line_items: lineItems,
      invoice_discount_pct: invoiceDiscountPct,
      subtotal,
      total,
      notes: body.notes,
      status: 'draft',
      created_by: user.id,
      created_by_email: user.email,
    })
    .select('id, invoice_number, status')
    .maybeSingle();
  if (error || !inserted) {
    return NextResponse.json(
      { error: error?.message ?? 'Insert failed' },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    id: inserted.id,
    invoice_number: inserted.invoice_number,
    status: inserted.status,
  });
}
