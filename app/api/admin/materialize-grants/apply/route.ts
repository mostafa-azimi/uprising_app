import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { giftCardCreate, giftCardCredit } from '@/lib/shopify';
import { upsertProfile } from '@/lib/klaviyo';
import { recomputeBalance } from '@/lib/customers';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * PHASE 2 — Apply.
 *
 * For each customer in the request:
 *   - Re-fetch their unlinked active grants (drift safety)
 *   - If total balance > 0:
 *       * If customer already has a Shopify card, credit that card by the
 *         missing amount (so Shopify catches up to our DB) and link grants
 *       * Otherwise create a new Shopify gift card with the total balance
 *         and link both customer + all unlinked grants to it
 *       * Push new code (if newly created) to Klaviyo
 *   - If total balance == 0:
 *       * Mark all unlinked grants fully_redeemed (no Shopify call)
 *
 * Idempotent: if a customer's grants are already linked between request and
 * apply, we skip them.
 */

interface ApplyInputRow {
  customer_id: string;
  email: string;
  total_balance: number;       // what preview saw
  grant_count: number;          // what preview saw
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  status: 'created_card' | 'credited_existing_card' | 'zeroed_only' | 'in_sync' | 'stale' | 'error';
  shopify_gift_card_id?: string | null;
  loyalty_card_code?: string | null;
  amount_credited?: number;
  grants_touched: number;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  shopify_cards_created: number;
  shopify_cards_credited: number;
  zero_balance_zeroed: number;
  rows_in_sync: number;
  rows_stale: number;
  rows_errored: number;
  total_balance_materialized: number;
  klaviyo_pushed: number;
  klaviyo_errors: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'materialize-grants-apply', level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  let body: { rows?: ApplyInputRow[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const inputRows = Array.isArray(body.rows) ? body.rows : [];
  if (inputRows.length === 0) {
    return NextResponse.json({ error: 'no rows to apply' }, { status: 400 });
  }

  log('info', 'started', { rows_received: inputRows.length, user: user.email });

  const supabase = createSupabaseServiceClient();
  const result: ApplyResult = {
    ok: true,
    generated_at: new Date().toISOString(),
    rows_received: inputRows.length,
    shopify_cards_created: 0,
    shopify_cards_credited: 0,
    zero_balance_zeroed: 0,
    rows_in_sync: 0,
    rows_stale: 0,
    rows_errored: 0,
    total_balance_materialized: 0,
    klaviyo_pushed: 0,
    klaviyo_errors: 0,
    duration_ms: 0,
    outcomes: [],
  };

  for (const row of inputRows) {
    const outcome: ApplyOutcome = {
      customer_id: row.customer_id,
      email: row.email,
      status: 'in_sync',
      grants_touched: 0,
    };

    try {
      // 1. Fetch the customer's current state (and its current shopify_gift_card_id)
      const { data: customer, error: cErr } = await supabase
        .from('customers')
        .select('id, email, first_name, last_name, shopify_gift_card_id, shopify_gift_card_last4, loyalty_card_code')
        .eq('id', row.customer_id)
        .maybeSingle();
      if (cErr || !customer) throw new Error(cErr?.message ?? 'customer not found');

      // 2. Re-fetch unlinked active grants for this customer
      const { data: grantsData, error: gErr } = await supabase
        .from('grants')
        .select('id, remaining_amount, expires_on')
        .eq('customer_id', row.customer_id)
        .eq('status', 'active')
        .is('shopify_gift_card_id', null);
      if (gErr) throw new Error(`grants query: ${gErr.message}`);

      const grants = (grantsData ?? []).map((g) => ({
        id: g.id,
        remaining_amount: Number(g.remaining_amount),
        expires_on: g.expires_on,
      }));

      // Stale check: if drift between preview's grant_count and live, abort
      if (Math.abs(grants.length - row.grant_count) > 0) {
        outcome.status = 'stale';
        outcome.detail = `live unlinked grants now ${grants.length} (preview saw ${row.grant_count})`;
        result.rows_stale++;
        result.outcomes.push(outcome);
        continue;
      }

      if (grants.length === 0) {
        outcome.status = 'in_sync';
        outcome.detail = 'no unlinked active grants left';
        result.rows_in_sync++;
        result.outcomes.push(outcome);
        continue;
      }

      const totalBalance = Math.round(grants.reduce((s, g) => s + g.remaining_amount, 0) * 100) / 100;
      // Ensure preview's balance number is consistent (cheap drift check)
      if (Math.abs(totalBalance - row.total_balance) > 0.01) {
        outcome.status = 'stale';
        outcome.detail = `live balance now $${totalBalance.toFixed(2)} (preview saw $${row.total_balance.toFixed(2)})`;
        result.rows_stale++;
        result.outcomes.push(outcome);
        continue;
      }

      // 3. Branch on total balance
      if (totalBalance < 0.005) {
        // $0 case — just mark fully_redeemed, no Shopify call
        const grantIds = grants.map((g) => g.id);
        const { error: upErr } = await supabase
          .from('grants')
          .update({
            status: 'fully_redeemed',
            expired_at: new Date().toISOString(),
          })
          .in('id', grantIds);
        if (upErr) throw new Error(`grants status update: ${upErr.message}`);
        outcome.status = 'zeroed_only';
        outcome.grants_touched = grantIds.length;
        result.zero_balance_zeroed++;
        result.outcomes.push(outcome);
        continue;
      }

      // Positive balance case
      let shopifyCardId: string;
      let shopifyCardCode: string | null;
      let shopifyCardLast4: string | null;
      let amountCredited = 0;
      let createdNew = false;

      if (customer.shopify_gift_card_id) {
        // Customer already has a card — credit it by the unlinked total
        const credit = await giftCardCredit(
          customer.shopify_gift_card_id,
          totalBalance.toFixed(2),
          `Materialize unlinked grants — bringing Shopify in sync with DB`
        );
        shopifyCardId = customer.shopify_gift_card_id;
        shopifyCardCode = customer.loyalty_card_code ?? null;
        shopifyCardLast4 = customer.shopify_gift_card_last4 ?? null;
        amountCredited = totalBalance;
        result.shopify_cards_credited++;
        outcome.status = 'credited_existing_card';
        void credit; // transactionId not needed here
      } else {
        // No card — create a fresh one with the total balance
        const card = await giftCardCreate({
          initialValue: totalBalance.toFixed(2),
          note: `Materialize unlinked grants for ${customer.email}`,
          // Don't set expiresOn on the card itself — per-grant expiration is in our DB
        });
        if (!card.code) {
          throw new Error('giftCardCreate returned no code (only available at creation)');
        }
        shopifyCardId = card.id;
        shopifyCardCode = card.code;
        shopifyCardLast4 = card.lastCharacters ?? card.code.slice(-4);
        amountCredited = totalBalance;
        createdNew = true;
        result.shopify_cards_created++;
        outcome.status = 'created_card';
      }

      // 4. Link all the customer's unlinked active grants to this card
      const grantIds = grants.map((g) => g.id);
      const { error: gUpErr } = await supabase
        .from('grants')
        .update({
          shopify_gift_card_id: shopifyCardId,
          shopify_gift_card_code: shopifyCardCode,
          shopify_gift_card_last4: shopifyCardLast4,
        })
        .in('id', grantIds);
      if (gUpErr) throw new Error(`grants link update: ${gUpErr.message}`);

      // 5. Update customer pointer if we created a new card
      if (createdNew) {
        const { error: cUpErr } = await supabase
          .from('customers')
          .update({
            shopify_gift_card_id: shopifyCardId,
            loyalty_card_code: shopifyCardCode,
            shopify_gift_card_last4: shopifyCardLast4,
          })
          .eq('id', customer.id);
        if (cUpErr) throw new Error(`customer link update: ${cUpErr.message}`);
      }

      // 6. Recompute balance + push Klaviyo (current code + balance)
      try {
        const newBalance = await recomputeBalance(customer.id);
        try {
          await upsertProfile({
            email: customer.email,
            first_name: customer.first_name ?? undefined,
            last_name: customer.last_name ?? undefined,
            properties: {
              loyalty_card_balance: newBalance,
              ...(shopifyCardCode ? { loyalty_card_code: shopifyCardCode } : {}),
            },
          });
          result.klaviyo_pushed++;
        } catch (e) {
          result.klaviyo_errors++;
          await supabase.from('sync_log').insert({
            target: 'klaviyo',
            operation: 'materialize_klaviyo_push',
            entity_id: customer.id,
            ok: false,
            error_message: (e as Error).message,
          });
        }
      } catch (e) {
        log('warn', 'recompute_failed', { customer_id: customer.id, error: (e as Error).message });
      }

      // 7. Audit log entry
      await supabase.from('sync_log').insert({
        target: 'shopify',
        operation: 'materialize_grants',
        entity_id: customer.id,
        ok: true,
        request_body: {
          email: customer.email,
          grant_count: grantIds.length,
          total_balance: totalBalance,
          mode: createdNew ? 'created_card' : 'credited_existing',
        },
        response_body: {
          shopify_gift_card_id: shopifyCardId,
          loyalty_card_code: shopifyCardCode,
        },
      });

      outcome.shopify_gift_card_id = shopifyCardId;
      outcome.loyalty_card_code = shopifyCardCode;
      outcome.amount_credited = amountCredited;
      outcome.grants_touched = grantIds.length;
      result.total_balance_materialized += totalBalance;
    } catch (e) {
      outcome.status = 'error';
      outcome.detail = (e as Error).message;
      result.rows_errored++;
      log('error', 'row_failed', {
        customer_id: row.customer_id,
        email: row.email,
        error: outcome.detail,
      });
      // Best-effort failure log
      await supabase.from('sync_log').insert({
        target: 'shopify',
        operation: 'materialize_grants',
        entity_id: row.customer_id,
        ok: false,
        error_message: outcome.detail,
        request_body: { email: row.email, total_balance: row.total_balance },
      });
    }
    result.outcomes.push(outcome);
  }

  result.total_balance_materialized = Math.round(result.total_balance_materialized * 100) / 100;
  result.duration_ms = Date.now() - t0;
  log('info', 'completed', {
    duration_ms: result.duration_ms,
    cards_created: result.shopify_cards_created,
    cards_credited: result.shopify_cards_credited,
    zeroed: result.zero_balance_zeroed,
    errored: result.rows_errored,
  });
  return NextResponse.json(result);
}
