import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { recomputeBalance } from '@/lib/customers';
import { upsertProfile } from '@/lib/klaviyo';
import { giftCardDebit, getGiftCard } from '@/lib/shopify';

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
  shopify_balance: number;             // target value (used for fix_db mode)
  db_total_remaining: number;          // what preview saw
  diff: number;                        // shopify - db at preview time
  expires_on?: string | null;          // optional override; if set, applies to all active grants on this card
  // mode (default 'fix_db' for back-compat):
  //   'fix_db'      — bring DB to match Shopify (existing behavior; debits/credits DB grants)
  //   'fix_shopify' — bring Shopify to match DB (debits Shopify card; DB unchanged). Only valid when diff > 0.
  mode?: 'fix_db' | 'fix_shopify';
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  shopify_gift_card_id: string;
  status: 'applied' | 'shopify_fixed' | 'in_sync' | 'stale' | 'error';
  prior_db_total: number;
  new_db_total: number;
  delta_applied: number;
  expiration_changed?: boolean;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  rows_applied: number;          // fix_db successes
  rows_shopify_fixed: number;    // fix_shopify successes
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
    rows_shopify_fixed: 0,
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

      // ============================================================
      // BRANCH: fix_shopify mode — debit Shopify down to match DB.
      // DB is left untouched. Only valid when Shopify > DB.
      // ============================================================
      if (row.mode === 'fix_shopify') {
        try {
          // Re-fetch live state to compute the actual diff (don't trust preview)
          const { data: liveGrants, error: gErr } = await supabase
            .from('grants')
            .select('remaining_amount')
            .eq('customer_id', row.customer_id)
            .eq('status', 'active');
          if (gErr) throw new Error(`grants query: ${gErr.message}`);
          const liveDbTotal = (liveGrants ?? []).reduce(
            (s, g) => s + Number(g.remaining_amount),
            0
          );
          outcome.prior_db_total = Math.round(liveDbTotal * 100) / 100;

          const card = await getGiftCard(row.shopify_gift_card_id);
          if (!card) throw new Error(`gift card not found in Shopify: ${row.shopify_gift_card_id}`);
          const liveShopify = Number(card.balance.amount);

          const liveDiff = liveShopify - liveDbTotal;
          // For fix_shopify, the diff must still be positive (Shopify > DB)
          if (liveDiff <= 0.005) {
            outcome.status = 'in_sync';
            outcome.detail = `Shopify is now $${liveShopify.toFixed(2)}, DB is $${liveDbTotal.toFixed(2)} — no longer needs Shopify fix`;
            outcome.new_db_total = liveDbTotal;
            result.rows_in_sync++;
            result.outcomes.push(outcome);
            continue;
          }

          // Stale check: if live diff differs materially from preview's diff, skip
          if (Math.abs(liveDiff - row.diff) > 0.01) {
            outcome.status = 'stale';
            outcome.detail = `live diff $${liveDiff.toFixed(2)} (preview saw $${row.diff.toFixed(2)})`;
            result.rows_stale++;
            result.outcomes.push(outcome);
            continue;
          }

          // Debit Shopify by liveDiff to bring it down to liveDbTotal
          await giftCardDebit(
            row.shopify_gift_card_id,
            liveDiff.toFixed(2),
            `Shopify sync reconciliation — debit Shopify to match DB ($${liveDbTotal.toFixed(2)})`
          );

          // Audit
          await supabase.from('sync_log').insert({
            target: 'shopify',
            operation: 'sync_reconcile_fix_shopify',
            entity_id: row.customer_id,
            ok: true,
            request_body: {
              email: row.email,
              gift_card_id: row.shopify_gift_card_id,
              shopify_before: Math.round(liveShopify * 100) / 100,
              shopify_after: Math.round(liveDbTotal * 100) / 100,
              db_total: Math.round(liveDbTotal * 100) / 100,
              debited: Math.round(liveDiff * 100) / 100,
              actor: user.email,
            },
          });

          outcome.status = 'shopify_fixed';
          outcome.delta_applied = -Math.round(liveDiff * 100) / 100; // negative since we debited Shopify
          outcome.new_db_total = liveDbTotal; // DB unchanged
          outcome.detail = `Debited Shopify by $${liveDiff.toFixed(2)}: $${liveShopify.toFixed(2)} → $${liveDbTotal.toFixed(2)}`;
          result.rows_shopify_fixed++;
          result.total_delta_applied += -liveDiff;
          // Note: don't recompute customer balance — DB didn't change.
          // Don't push Klaviyo either, customer's app balance is unchanged.
        } catch (e) {
          outcome.status = 'error';
          outcome.detail = (e as Error).message;
          result.rows_errored++;
          await supabase.from('sync_log').insert({
            target: 'shopify',
            operation: 'sync_reconcile_fix_shopify',
            entity_id: row.customer_id,
            ok: false,
            error_message: outcome.detail,
            request_body: { email: row.email, gift_card_id: row.shopify_gift_card_id },
          });
        }
        result.outcomes.push(outcome);
        continue;
      }

      // ============================================================
      // BRANCH: fix_db mode (default) — bring DB to match Shopify.
      // Existing behavior, unchanged. Touches grants + ledger.
      // ============================================================

      try {
        // Validate optional expires_on override (YYYY-MM-DD)
        const rowExpiresOn = (row.expires_on && /^\d{4}-\d{2}-\d{2}$/.test(row.expires_on))
          ? row.expires_on
          : null;
        if (row.expires_on && !rowExpiresOn) {
          throw new Error(`invalid expires_on '${row.expires_on}' (expected YYYY-MM-DD)`);
        }

        // Re-fetch ALL active grants for this customer (any link state, including unlinked).
        // Reconcile is now matched at customer level, not grant level — the
        // customer.shopify_gift_card_id pointer says "all this customer's
        // active credit lives on that card", so every active grant counts
        // toward the comparison and is eligible for FIFO debit.
        const { data: grants, error } = await supabase
          .from('grants')
          .select('id, shopify_gift_card_id, remaining_amount, expires_on, status')
          .eq('customer_id', row.customer_id)
          .eq('status', 'active');
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

        // Compute effective expires_on per grant: row override (if any) wins
        type AugGrant = typeof activeGrants[number] & { effective_expires_on: string };
        const augmented: AugGrant[] = activeGrants.map((g) => ({
          ...g,
          effective_expires_on: rowExpiresOn ?? g.expires_on,
        }));
        const dateWillChangeForAny = rowExpiresOn !== null
          && augmented.some((g) => g.expires_on !== rowExpiresOn);

        // If balance is already in sync AND no date change is requested, skip
        if (Math.abs(liveDelta) < 0.005 && !dateWillChangeForAny) {
          outcome.status = 'in_sync';
          outcome.new_db_total = liveDbTotal;
          result.rows_in_sync++;
          result.outcomes.push(outcome);
          continue;
        }

        // Apportion delta across grants
        // - Negative liveDelta (DB > Shopify): FIFO debit by oldest effective expires_on
        // - Positive liveDelta (DB < Shopify): credit newest effective expires_on
        const ledgerInserts: Array<{
          customer_id: string;
          grant_id: string;
          type: 'adjust';
          amount: number;
          description: string;
          created_by: string | null;
          created_by_email: string | null;
        }> = [];
        // Tracks a per-grant new remaining if it gets debited/credited.
        // Grants not touched by balance change still get an expires_on update if rowExpiresOn is set.
        const grantBalanceChanges = new Map<string, number>(); // grant_id → new_remaining

        const dateNote = dateWillChangeForAny ? `; expiration set to ${rowExpiresOn}` : '';
        const balanceNote = Math.abs(liveDelta) >= 0.005
          ? `set total to $${targetBalance.toFixed(2)} (was $${liveDbTotal.toFixed(2)})`
          : `total unchanged at $${liveDbTotal.toFixed(2)}`;
        const baseDesc = `Shopify sync reconciliation — ${balanceNote}${dateNote}`;

        if (liveDelta < -0.005) {
          // Debit oldest effective-expiration first
          const ordered = [...augmented].sort(
            (a, b) => a.effective_expires_on.localeCompare(b.effective_expires_on)
              || a.id.localeCompare(b.id)
          );
          let toDebit = -liveDelta;
          for (const g of ordered) {
            if (toDebit <= 0.005) break;
            const cur = Number(g.remaining_amount);
            const take = Math.min(cur, toDebit);
            const newRem = Math.round((cur - take) * 100) / 100;
            grantBalanceChanges.set(g.id, newRem);
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: g.id,
              type: 'adjust',
              amount: -Math.round(take * 100) / 100,
              description: baseDesc,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
            toDebit -= take;
          }
          if (toDebit > 0.01) {
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: '',
              type: 'adjust',
              amount: -Math.round(toDebit * 100) / 100,
              description: `Shopify sync reconciliation — unmatched residual ($${toDebit.toFixed(2)} not allocatable to a grant)`,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
          }
        } else if (liveDelta > 0.005) {
          // Credit newest effective-expiration first
          const ordered = [...augmented].sort(
            (a, b) => b.effective_expires_on.localeCompare(a.effective_expires_on)
              || b.id.localeCompare(a.id)
          );
          const toCredit = liveDelta;
          if (ordered.length === 0) {
            // No active grants exist for this customer — create a NEW grant
            // to hold the credit. Without this, the ledger entry alone wouldn't
            // raise total_balance_cached because recomputeBalance only sums
            // active grants.
            const { data: existingEvent } = await supabase
              .from('events')
              .select('id')
              .eq('name', 'Manual Adjustments')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            let eventId = existingEvent?.id;
            if (!eventId) {
              const { data: createdEvent, error: evErr } = await supabase
                .from('events')
                .insert({ name: 'Manual Adjustments', host: 'Manual', status: 'completed', kind: 'system' })
                .select('id')
                .single();
              if (evErr) throw new Error(`event insert: ${evErr.message}`);
              eventId = createdEvent!.id;
            }

            // Pick an expiration: the row's override if set, otherwise 1 year from today
            const newExpiresOn = rowExpiresOn
              ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

            const { data: newGrant, error: ngErr } = await supabase
              .from('grants')
              .insert({
                customer_id: row.customer_id,
                event_id: eventId,
                initial_amount: toCredit,
                remaining_amount: toCredit,
                expires_on: newExpiresOn,
                reason: 'Shopify sync',
                note: `Shopify sync reconciliation — Shopify had $${targetBalance.toFixed(2)}, DB had $${liveDbTotal.toFixed(2)}`,
                status: 'active',
                shopify_gift_card_id: row.shopify_gift_card_id,
              })
              .select('id')
              .single();
            if (ngErr) throw new Error(`new grant insert: ${ngErr.message}`);

            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: newGrant!.id,
              type: 'adjust',
              amount: Math.round(toCredit * 100) / 100,
              description: baseDesc,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
          } else {
            const target = ordered[0];
            const cur = Number(target.remaining_amount);
            const newRem = Math.round((cur + toCredit) * 100) / 100;
            grantBalanceChanges.set(target.id, newRem);
            ledgerInserts.push({
              customer_id: row.customer_id,
              grant_id: target.id,
              type: 'adjust',
              amount: Math.round(toCredit * 100) / 100,
              description: baseDesc,
              created_by: user.id,
              created_by_email: user.email ?? 'shopify sync',
            });
          }
        }

        // Compute final grant updates: combines balance changes (if any) AND date changes (if any).
        // Every active grant gets touched if rowExpiresOn is set so the date is uniform across the card.
        const grantUpdates: Array<{
          id: string;
          new_remaining: number;
          new_expires_on: string;
          new_status: 'active' | 'fully_redeemed' | 'expired';
          date_changed: boolean;
        }> = augmented.map((g) => {
          const newRem = grantBalanceChanges.has(g.id)
            ? grantBalanceChanges.get(g.id)!
            : Number(g.remaining_amount);
          const effDate = g.effective_expires_on;
          return {
            id: g.id,
            new_remaining: newRem,
            new_expires_on: effDate,
            new_status: statusForGrant(newRem, effDate),
            date_changed: rowExpiresOn !== null && g.expires_on !== rowExpiresOn,
          };
        });

        // Write grant updates — only ones that actually need a write
        for (const u of grantUpdates) {
          const original = augmented.find((g) => g.id === u.id)!;
          // Detect if this grant is currently unlinked. If so, we link it
          // to the customer's Shopify card while we're touching it — that
          // way subsequent reconciles keep finding it correctly.
          const needsLink = (original as { shopify_gift_card_id?: string | null }).shopify_gift_card_id == null;
          const willChange =
            grantBalanceChanges.has(u.id) ||
            u.date_changed ||
            u.new_status !== original.status ||
            needsLink;
          if (!willChange) continue;
          const updates: Record<string, unknown> = {
            remaining_amount: u.new_remaining,
            status: u.new_status,
          };
          if (u.date_changed) updates.expires_on = u.new_expires_on;
          if (u.new_status === 'expired' || u.new_status === 'fully_redeemed') {
            updates.expired_at = new Date().toISOString();
          }
          if (needsLink) {
            updates.shopify_gift_card_id = row.shopify_gift_card_id;
          }
          const { error: upErr } = await supabase.from('grants').update(updates).eq('id', u.id);
          if (upErr) throw new Error(`grant update ${u.id}: ${upErr.message}`);
        }
        outcome.expiration_changed = dateWillChangeForAny;

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
