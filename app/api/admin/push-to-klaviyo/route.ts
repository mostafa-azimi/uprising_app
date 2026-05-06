import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { upsertProfileWithRetry } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Push the current Klaviyo-relevant DB state for customers active in a date
 * range. Used as a one-time catch-up after Klaviyo outages or after manual
 * SQL edits where Klaviyo wasn't kept in sync.
 *
 * Uses upsertProfileWithRetry, so any failure lands on the in-app banner +
 * failures page automatically.
 */

interface PreviewResult {
  ok: boolean;
  since: string;
  until: string | null;
  customer_count: number;             // total candidates in the date range
  already_pushed_count: number;       // already had a successful Klaviyo push since "since"
  remaining_count: number;            // candidates - already_pushed (these will be pushed)
  customer_ids_sample: string[];      // sample of remaining (not already pushed)
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

interface ApplyResult {
  ok: boolean;
  customers_attempted: number;
  succeeded: number;
  failed: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

const CONCURRENCY = 5;
const PAGE = 1000;
const MAX_PER_CALL = 200;

/**
 * Find distinct customer_ids that had a ledger entry in the date range.
 * These are the "potentially out of sync with Klaviyo" customers.
 */
async function findRecentlyActiveCustomers(args: {
  sinceISO: string;
  untilISO?: string | null;
}): Promise<string[]> {
  const supabase = createSupabaseServiceClient();
  const ids = new Set<string>();
  let from = 0;
  while (true) {
    let q = supabase
      .from('ledger')
      .select('customer_id, created_at')
      .gte('created_at', args.sinceISO)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (args.untilISO) q = q.lte('created_at', args.untilISO);
    const { data, error } = await q;
    if (error) throw new Error(`ledger query: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.customer_id) ids.add(r.customer_id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return Array.from(ids);
}

/**
 * Of a candidate set, return the customer_ids that already received a
 * successful Klaviyo push within the date range. We treat these as "done"
 * so repeated Push clicks make forward progress instead of re-pushing the
 * same first 200 over and over.
 */
async function findAlreadyPushedSince(args: {
  candidateIds: string[];
  sinceISO: string;
}): Promise<Set<string>> {
  const supabase = createSupabaseServiceClient();
  const out = new Set<string>();
  if (args.candidateIds.length === 0) return out;
  // Chunk to avoid PostgREST URL length limit on .in()
  const FETCH_CHUNK = 100;
  for (let i = 0; i < args.candidateIds.length; i += FETCH_CHUNK) {
    const slice = args.candidateIds.slice(i, i + FETCH_CHUNK);
    const { data, error } = await supabase
      .from('sync_log')
      .select('entity_id, created_at')
      .eq('target', 'klaviyo')
      .eq('operation', 'profile_property_sync')
      .eq('ok', true)
      .in('entity_id', slice)
      .gte('created_at', args.sinceISO);
    if (error) throw new Error(`sync_log query: ${error.message}`);
    (data ?? []).forEach((r) => {
      if (r.entity_id) out.add(r.entity_id);
    });
  }
  return out;
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  try {
    await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as {
    action?: 'preview' | 'apply';
    since?: string;
    until?: string;
  };

  if (!body.since) {
    return NextResponse.json({ error: 'since is required (ISO date)' }, { status: 400 });
  }
  const sinceDate = new Date(body.since);
  if (isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: `invalid since: ${body.since}` }, { status: 400 });
  }
  const sinceISO = sinceDate.toISOString();
  let untilISO: string | null = null;
  if (body.until) {
    const u = new Date(body.until);
    if (isNaN(u.getTime())) {
      return NextResponse.json({ error: `invalid until: ${body.until}` }, { status: 400 });
    }
    untilISO = u.toISOString();
  }

  let candidateIds: string[];
  let alreadyPushed: Set<string>;
  try {
    candidateIds = await findRecentlyActiveCustomers({ sinceISO, untilISO });
    alreadyPushed = await findAlreadyPushedSince({ candidateIds, sinceISO });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Remaining = candidates - already-pushed. These are the ones we still need to push.
  const remainingIds = candidateIds.filter((id) => !alreadyPushed.has(id));

  if (body.action === 'preview') {
    const result: PreviewResult = {
      ok: true,
      since: sinceISO,
      until: untilISO,
      customer_count: candidateIds.length,
      already_pushed_count: alreadyPushed.size,
      remaining_count: remainingIds.length,
      customer_ids_sample: remainingIds.slice(0, 20),
    };
    return NextResponse.json(result);
  }

  // Apply path — synchronously push, with concurrency, capped per call.
  const ids = remainingIds.slice(0, MAX_PER_CALL);

  const supabase = createSupabaseServiceClient();
  // Fetch all customer records in one batch (chunked to avoid URL limit)
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

  const outcomes: ApplyOutcome[] = [];
  let nextIndex = 0;

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
        reason: 'push-to-klaviyo-catchup',
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

  const result: ApplyResult = {
    ok: true,
    customers_attempted: customers.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    duration_ms: Date.now() - t0,
    outcomes,
  };
  return NextResponse.json(result);
}
