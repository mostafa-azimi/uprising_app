import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { upsertProfileWithRetry } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Retry a Klaviyo profile push for one or more customers. Used by the
 * /admin/klaviyo-failures page's per-row "Retry now" button.
 * Synchronous (not waitUntil) — caller wants to know if it worked.
 */

interface RetryBody {
  customer_ids?: string[];
}

interface RetryOutcome {
  customer_id: string;
  email: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  let body: RetryBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const ids = (body.customer_ids ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'customer_ids is required' }, { status: 400 });
  }
  if (ids.length > 50) {
    return NextResponse.json({ error: 'max 50 customers per retry call' }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, loyalty_card_code, total_balance_cached, expiration_date')
    .in('id', ids);
  if (error) {
    return NextResponse.json({ error: `customers query: ${error.message}` }, { status: 500 });
  }

  const outcomes: RetryOutcome[] = [];
  for (const c of customers ?? []) {
    const r = await upsertProfileWithRetry({
      email: c.email,
      first_name: c.first_name ?? undefined,
      last_name: c.last_name ?? undefined,
      properties: {
        loyalty_card_balance: Number(c.total_balance_cached ?? 0),
        ...(c.loyalty_card_code ? { loyalty_card_code: c.loyalty_card_code } : {}),
        ...(c.expiration_date ? { expiration_date: c.expiration_date } : {}),
      },
      customer_id_for_log: c.id,
      reason: 'manual-retry-from-failures-page',
    });
    outcomes.push({
      customer_id: c.id,
      email: c.email,
      ok: r.ok,
      attempts: r.attempts,
      error: r.error,
    });
  }

  return NextResponse.json({
    rows_received: ids.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  });
}
