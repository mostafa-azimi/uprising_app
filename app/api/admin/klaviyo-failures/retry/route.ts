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
  retry_all_pending?: boolean;   // if true, ignore customer_ids and pull every unresolved failure
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

  const supabase = createSupabaseServiceClient();
  let ids: string[];

  if (body.retry_all_pending === true) {
    // Pull every unresolved terminal failure (last 30 days) and retry them all.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: failures } = await supabase
      .from('sync_log')
      .select('entity_id, created_at')
      .eq('target', 'klaviyo')
      .eq('operation', 'profile_property_sync_failed_after_retries')
      .gte('created_at', since)
      .order('created_at', { ascending: false });

    const latestFailureByCustomer = new Map<string, string>();
    (failures ?? []).forEach((f) => {
      if (!f.entity_id) return;
      if (!latestFailureByCustomer.has(f.entity_id)) {
        latestFailureByCustomer.set(f.entity_id, f.created_at);
      }
    });
    const candidateIds = Array.from(latestFailureByCustomer.keys());

    if (candidateIds.length === 0) {
      return NextResponse.json({ rows_received: 0, succeeded: 0, failed: 0, outcomes: [] });
    }

    // Filter out resolved (a successful push already happened after the failure)
    const { data: successes } = await supabase
      .from('sync_log')
      .select('entity_id, created_at')
      .eq('target', 'klaviyo')
      .eq('operation', 'profile_property_sync')
      .eq('ok', true)
      .in('entity_id', candidateIds)
      .gte('created_at', since);
    const latestSuccess = new Map<string, string>();
    (successes ?? []).forEach((s) => {
      if (!s.entity_id) return;
      const cur = latestSuccess.get(s.entity_id);
      if (!cur || s.created_at > cur) latestSuccess.set(s.entity_id, s.created_at);
    });

    ids = [];
    for (const [cid, failTs] of latestFailureByCustomer) {
      const successTs = latestSuccess.get(cid);
      if (!successTs || successTs < failTs) ids.push(cid);
    }
    // Cap to 200 per call to keep within function lifetime
    if (ids.length > 200) ids = ids.slice(0, 200);
  } else {
    ids = (body.customer_ids ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) {
      return NextResponse.json({ error: 'customer_ids or retry_all_pending is required' }, { status: 400 });
    }
    if (ids.length > 200) {
      return NextResponse.json({ error: 'max 200 customers per retry call' }, { status: 400 });
    }
  }

  // Fetch customer data for the ids in chunks
  interface CustomerRow {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    loyalty_card_code: string | null;
    total_balance_cached: number | null;
    expiration_date: string | null;
  }
  const customers: CustomerRow[] = [];
  const FETCH_CHUNK = 100;
  for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
    const slice = ids.slice(i, i + FETCH_CHUNK);
    const { data, error } = await supabase
      .from('customers')
      .select('id, email, first_name, last_name, loyalty_card_code, total_balance_cached, expiration_date')
      .in('id', slice);
    if (error) {
      return NextResponse.json({ error: `customers query: ${error.message}` }, { status: 500 });
    }
    customers.push(...(data ?? []));
  }

  const outcomes: RetryOutcome[] = [];
  // Run with concurrency 5 — much faster than sequential when retrying many.
  let nextIndex = 0;
  const CONCURRENCY = 5;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= customers.length) return;
      const c = customers[i];
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
        reason: body.retry_all_pending ? 'retry-all-pending' : 'manual-retry-from-failures-page',
      });
      outcomes.push({
        customer_id: c.id,
        email: c.email,
        ok: r.ok,
        attempts: r.attempts,
        error: r.error,
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return NextResponse.json({
    rows_received: ids.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  });
}
