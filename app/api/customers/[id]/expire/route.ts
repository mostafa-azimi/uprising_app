import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { expireCustomerBalance } from '@/lib/expire';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { data: admin } = await auth.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { skipShopify?: boolean };
  const skipShopify = body.skipShopify === true;
  const reason = `Expire by ${user.email ?? user.id}${skipShopify ? ' (DB only — Shopify skipped)' : ''}`;
  const result = await expireCustomerBalance(
    params.id,
    reason,
    { id: user.id, email: user.email ?? null },
    { skipShopify },
  );
  if (!result.ok) return NextResponse.json({ error: result.error ?? 'expire failed', result }, { status: 500 });
  return NextResponse.json(result);
}
