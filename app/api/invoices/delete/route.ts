import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireMember } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Hard-delete an invoice. Used to clean up draft / errored rows that the user
 * doesn't want to keep around — re-issuing the same invoice number after delete
 * isn't supported (the Postgres sequence keeps moving), so think of this as
 * "throw this draft away".
 */

const Body = z.object({
  id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    await requireMember();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid request body: ${(e as Error).message}` },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceClient();

  const { data: existing } = await supabase
    .from('invoices')
    .select('id, invoice_number, status')
    .eq('id', body.id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const { error } = await supabase.from('invoices').delete().eq('id', body.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    deleted_id: existing.id,
    deleted_invoice_number: existing.invoice_number,
  });
}
