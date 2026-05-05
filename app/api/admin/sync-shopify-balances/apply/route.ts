import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { recomputeBalance } from '@/lib/customers';
import { upsertProfile } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * PHASE 2 — Apply.
 *
 * Receives the discrepancy rows from preview. For each (customer, gift_card),
 * apportions the diff across that customer's grants on that card:
 *   - DB > Shopify (negative diff): FIFO oldest expiration first, debit until done
 *   - DB < Shopify (positive diff): credit the newest grant
 *
 * Each grant touched gets a ledger row of type='adjust' with description
 * "Shopify sync reconciliation — set to $X (was $Y)" and the precise delta.
 *
 * Re-checks the current DB total before writing. If it's drifted from what
 * preview saw (someone else made an edit), the row is skipped and reported
 * as "stale" so we don't double-correct.
 */

interface ApplyRow {
  customer_id: string;
  email: string;
  shopify_gift_card_id: string;
  shopify_balance: number;             // target value
  db_total_remaining: number;          // what preview saw
  diff: number;                        // shopify - db at preview time
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  shopify_gift_card_id: string;
  status: 'applied' | 'in_sync' | 'stale' | 'error';
  prior_db_total: number;
  new_db_total: number;
  delta_applied: number;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  rows_applied: number;
  rows_in_sync: number;
  rows_stale: number;
  rows_errored: number;
  total_delta_applied: number;
  customers_recomputed: number;
  klaviyo_pushed: number;
  klaviyo_errors: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'sync-shopify-balances-apply', level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function statusForGrant(remaining: number, expiresOn: string): 'active' | 'fully_redeemed' | 'expired' {
  const isPastDue = expiresOn < todayISO();
  if (remaining <= 0.005) return isPastDue ? 'expired' : 'fully_redeemed';
  return isPastDue ? 'expired' : 'active';
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  let body: { rows?: ApplyRow[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no rows to apply' }, { status: 400 });
  }

  log('info', 'started', { rows_received: rows.length, user: user.email });

  const supabase = createSupabaseServiceClient();
  const result: ApplyResult = {
    ok: true,
    generated_at: new Date().toISOString(),
    rows_received: rows.length,
    rows_applied: 0,
    rows_in_sync: 0,
    rows_stale: 0,
    rows_errored: 0,
    total_delta_applied: 0,
    customers_recomputed: 0,
    klaviyo_pushed: 0,
    klaviyo_errors: 0,
    duration_ms: 0,
    outcomes: [],
  };

  try {
    const affectedCustomerIds = new Set<string>();

    for (const row of rows) {
      const outcome: ApplyOutcome = {
        customer_id: row.customer_id,
        email: row.email,
        shopify_gift_card_id: row.shopify_gift_card_id,
        status: 'applied',
        prior_db_total: 0,
        new_db_total: 0,
        delta_applied: 0,
      };

      try {
        // Re-fetch current grants for this (customer, card). If the live DB
        // total has drifted from what preview saw, skip and report "stale".
        const { data: grants, error } = await supabase
          .from('grants')
          .select('id, remaining_amount, expires_on, status')
          .eq('customer_id', row.customer_id)
          .eq('shopify_gift_card_id', row.shopify_gift_card_id);
        if (error) throw new Error(`grants query: ${error.message}`);
        const grantList = grants ?? [];

        const activeGrants = grantList.filter((g) => g.status === 'active');
        const liveDbTotal = activeGrants.reduce((s, g) => s + Number(g.remaining_amount), 0);
        outcome.prior_db_total = Math.round(liveDbTotal * 100) / 100;

        // Stale check: preview saw db_total_remaining; if live is materially different, abort this row
        if (Math.abs(liveDbTotal - row.db_total_remaining) > 0.01) {
          outcome.status = 'stale';
          outcome.detail = `live DB now $${liveDbTotal.toFixed(2)} (preview saw $${row.db_total_remaining.toFixed(2)})`;
          result.rows_stale++;
          result.outcomes.push(outcome);
          continue;
        }

        const targetBalance = Math.round(row.shopify_balance * 100) / 100;
        const liveDelta = targetBalance - liveDbTotal;
        if (Math.abs(liveDelta) < 0.005) {
          outcome.status = 'in_sync';
          outcome.new_db_total = liveDbTotal;
          result.rows_in_sync++;
          result.outcomes.push(outcome);
          continue;
        }

        // Apportion delta across grants
        // - Negative liveDelta (DB > Shopify): FIFO debit by oldest expires_on
        // - Positive liveDelta (DB < Shopify): credit newest expires_on
        let remainingToApply = liveDelta;
        const ledgerInserts: Array<{
          customer_id: string;
          grant_id: string;
          type: 'adjust';
          amount: number;
          description: string;
          created_by: string | null;
          created_by_email: string | null;
        }> = [];
        const grantUpdates: Array<{
          id: string;
          new_remaining: number;
          new_status: 'active' | 'fully_redeemed' | 'expired';
        }> = [];

        if (liveDelta < 0) {
          // Debit: oldest expires_on first
          const ordered = [...activeGrants].sort((a, b) => a.expires_on.localeCompare(b.expires_on));
          let toDebit = -liveDelta; // positive amount we need to remove
          for (const g of ordered) {
            if (toDebit <= 0.005) break;
            const cur = Number(g.remaining_amount);
            const take = Math.min(cur, toDebit);
            const newRem = Math.round((cur - take) * 100) / 100;
            grantUpdates.push({
              id: g.id,
              new_remaining: newRem,
              new_status: statusForGrant(newRem, g.expires_on),
            });
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: g.id,
              type: 'adjust',
              amount: -Math.round(take * 100) / 100,
              description: `Shopify sync reconciliation — set total to $${targetBalance.toFixed(2)} (was $${liveDbTotal.toFixed(2)})`,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
            toDebit -= take;
          }
          if (toDebit > 0.01) {
            // Couldn't fully debit — DB has less than expected. Record an unmatched entry.
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: '',          // will be replaced with null below
              type: 'adjust',
              amount: -Math.round(toDebit * 100) / 100,
              description: `Shopify sync reconciliation — unmatched residual ($${toDebit.toFixed(2)} not allocatable to a grant)`,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
          }
        } else {
          // Credit: newest grant first (longest expiration window)
          const ordered = [...activeGrants].sort((a, b) => b.expires_on.localeCompare(a.expires_on));
          let toCredit = liveDelta;
          if (ordered.length === 0) {
            // No active grant to credit — record as unmatched ledger entry, no grant updates
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: '',
              type: 'adjust',
              amount: Math.round(toCredit * 100) / 100,
              description: `Shopify sync reconciliation — set total to $${targetBalance.toFixed(2)} (was $${liveDbTotal.toFixed(2)}, no active grant to credit)`,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
            toCredit = 0;
          } else {
            const target = ordered[0];
            const cur = Number(target.remaining_amount);
            const newRem = Math.round((cur + toCredit) * 100) / 100;
            grantUpdates.push({
              id: target.id,
              new_remaining: newRem,
              new_status: statusForGrant(newRem, target.expires_on),
            });
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: target.id,
              type: 'adjust',
              amount: Math.round(toCredit * 100) / 100,
              description: `Shopify sync reconciliation — set total to $${targetBalance.toFixed(2)} (was $${liveDbTotal.toFixed(2)})`,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
            toCredit = 0;
          }
        }

        // Write grant updates
        for (const u of grantUpdates) {
          const updates: Record<string, unknown> = {
            remaining_amount: u.new_remaining,
            status: u.new_status,
          };
          if (u.new_status === 'expired' || u.new_status === 'fully_redeemed') {
            updates.expired_at = new Date().toISOString();
          }
          const { error: upErr } = await supabase.from('grants').update(updates).eq('id', u.id);
          if (upErr) throw new Error(`grant update ${u.id}: ${upErr.message}`);
        }

        // Write ledger entries (replace empty grant_id with null for unmatched residuals)
        const ledgerPayload = ledgerInserts.map((l) => ({
          ...l,
          grant_id: l.grant_id === '' ? null : l.grant_id,
        }));
        if (ledgerPayload.length > 0) {
          const { error: lErr } = await supabase.from('ledger').insert(ledgerPayload);
          if (lErr) throw new Error(`ledger insert: ${lErr.message}`);
        }

        outcome.delta_applied = Math.round(liveDelta * 100) / 100;
        outcome.new_db_total = targetBalance;
        result.total_delta_applied += liveDelta;
        result.rows_applied++;
        affectedCustomerIds.add(row.customer_id);
      } catch (e) {
        outcome.status = 'error';
        outcome.detail = (e as Error).message;
        result.rows_errored++;
        log('error', 'row_failed', {
          customer_id: row.customer_id,
          email: row.email,
          gid: row.shopify_gift_card_id,
          error: outcome.detail,
        });
      }
      result.outcomes.push(outcome);
    }

    // Recompute total_balance_cached for every affected customer + push to Klaviyo
    log('info', 'recomputing_balances', { count: affectedCustomerIds.size });
    const idList = Array.from(affectedCustomerIds);
    const CHUNK = 25;
    for (let i = 0; i < idList.length; i += CHUNK) {
      const slice = idList.slice(i, i + CHUNK);
      const { data: customers } = await supabase
        .from('customers')
        .select('id, email, first_name, last_name, loyalty_card_code')
        .in('id', slice);

      await Promise.all((customers ?? []).map(async (c) => {
        try {
          const newBalance = await recomputeBalance(c.id);
          result.customers_recomputed++;
          try {
            await upsertProfile({
              email: c.email,
              first_name: c.first_name ?? undefined,
              last_name: c.last_name ?? undefined,
              properties: {
                loyalty_card_balance: newBalance,
                ...(c.loyalty_card_code ? { loyalty_card_code: c.loyalty_card_code } : {}),
              },
            });
            result.klaviyo_pushed++;
          } catch {
            result.klaviyo_errors++;
          }
        } catch (e) {
          log('warn', 'recompute_failed', { customer_id: c.id, error: (e as Error).message });
        }
      }));
    }

    result.total_delta_applied = Math.round(result.total_delta_applied * 100) / 100;
    result.duration_ms = Date.now() - t0;
    log('info', 'completed', {
      duration_ms: result.duration_ms,
      applied: result.rows_applied,
      stale: result.rows_stale,
      errored: result.rows_errored,
      total_delta: result.total_delta_applied,
    });
    return NextResponse.json(result);
  } catch (e) {
    const errMsg = (e as Error).message ?? String(e);
    log('error', 'unhandled_exception', {
      error: errMsg,
      stack: ((e as Error).stack ?? '').slice(0, 2000),
      duration_ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: `Server error after ${Math.round((Date.now() - t0) / 1000)}s: ${errMsg}` },
      { status: 500 }
    );
  }
}
