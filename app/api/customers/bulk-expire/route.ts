import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { expireCustomerBalance, type ExpireResult } from '@/lib/expire';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // Auth gate
  const auth = createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: admin } = await auth
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!admin) return NextResponse.json({ error: 'Forbidden — not an admin' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { customerIds?: string[] };
  const ids = (body.customerIds ?? []).filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'No customerIds provided' }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: 'Maximum 200 customers per bulk-expire (was ' + ids.length + ')' }, { status: 400 });
  }

  const reason = `Bulk expire by ${user.email ?? user.id}`;
  const results: ExpireResult[] = [];
  let totalDebited = 0;
  let succeeded = 0;
  let failed = 0;

  for (const id of ids) {
    const r = await expireCustomerBalance(id, reason, { id: user.id, email: user.email ?? null });
    results.push(r);
    if (r.ok) {
      succeeded++;
      totalDebited += r.shopify_debited;
    } else {
      failed++;
    }
  }

  return NextResponse.json({
    succeeded,
    failed,
    total_debited: Math.round(totalDebited * 100) / 100,
    results,
  });
}
