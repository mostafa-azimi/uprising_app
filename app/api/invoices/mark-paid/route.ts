import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireMember } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Marks an invoice as paid. Idempotent — calling twice is fine, paid_at sticks
 * to whatever was set the first time.
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
    .select('id, status, paid_at')
    .eq('id', body.id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  if (existing.status === 'paid') {
    return NextResponse.json({ ok: true, paid_at: existing.paid_at });
  }

  const paidAt = new Date().toISOString();
  const { error } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: paidAt })
    .eq('id', body.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, paid_at: paidAt });
}
