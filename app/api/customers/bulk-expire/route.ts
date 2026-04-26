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

  // Run with bounded concurrency. Shopify GraphQL is cost-based (1000 point budget,
  // ~10 points per debit) and Klaviyo's profile API allows 75/sec — concurrency of 5
  // is safe and gives roughly a 5x speedup over sequential processing.
  const CONCURRENCY = 5;
  const t0 = Date.now();

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const slice = ids.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      slice.map((id) => expireCustomerBalance(id, reason, { id: user.id, email: user.email ?? null }))
    );
    for (const r of batch) {
      results.push(r);
      if (r.ok) {
        succeeded++;
        totalDebited += r.shopify_debited;
      } else {
        failed++;
      }
    }
  }

  return NextResponse.json({
    succeeded,
    failed,
    total_debited: Math.round(totalDebited * 100) / 100,
    duration_ms: Date.now() - t0,
    concurrency: CONCURRENCY,
    results,
  });
}
