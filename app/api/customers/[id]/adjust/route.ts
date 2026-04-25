import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { adjustCustomerBalance } from '@/lib/expire';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { data: admin } = await auth.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { amount?: number; reason?: string; expiresOn?: string };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ error: 'amount must be a nonzero number' }, { status: 400 });
  }
  const reason = (body.reason ?? '').trim() || `Adjust by ${user.email ?? user.id}`;

  const result = await adjustCustomerBalance({
    customerId: params.id,
    amount,
    reason,
    expiresOn: body.expiresOn,
  });
  if (!result.ok) return NextResponse.json({ error: result.error ?? 'adjust failed' }, { status: 500 });
  return NextResponse.json(result);
}
