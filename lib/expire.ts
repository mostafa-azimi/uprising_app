/**
 * Expire / adjust balance helpers — used by single-customer and bulk actions.
 */

import { waitUntil } from '@vercel/functions';
import { createSupabaseServiceClient } from './supabase/server';
import { giftCardCredit, giftCardDebit, getGiftCard } from './shopify';
import { upsertProfile, upsertProfileWithRetry } from './klaviyo';
import { recomputeBalance } from './customers';

/**
 * SYNC-TO-TOTAL: bring Shopify gift card balance to a target value, regardless
 * of where it started. Used by manual adjust + expire so that drift between
 * our DB and Shopify resolves into the new app total instead of pushing the
 * delta blindly. Idempotent — calling twice with the same target is a no-op
 * the second time.
 *
 * Returns the diff that was actually applied to Shopify (positive = credit,
 * negative = debit, zero = no-op).
 */
async function syncShopifyToTarget(args: {
  giftCardId: string;
  newAppTotal: number;
  noteForShopify: string;
  customerIdForLog: string;
}): Promise<{
  ok: boolean;
  shopify_before: number;
  shopify_after: number;
  diff_applied: number;
  error?: string;
}> {
  const supabase = createSupabaseServiceClient();

  // 1. Fetch current Shopify balance
  let shopifyBefore: number;
  try {
    const card = await getGiftCard(args.giftCardId);
    if (!card) {
      throw new Error(`gift card not found in Shopify: ${args.giftCardId}`);
    }
    shopifyBefore = Number(card.balance.amount);
  } catch (e) {
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'sync_to_total_fetch',
      entity_id: args.customerIdForLog,
      ok: false,
      error_message: (e as Error).message,
      request_body: { gift_card_id: args.giftCardId },
    });
    return {
      ok: false,
      shopify_before: 0,
      shopify_after: 0,
      diff_applied: 0,
      error: `getGiftCard: ${(e as Error).message}`,
    };
  }

  const target = Math.round(args.newAppTotal * 100) / 100;
  const before = Math.round(shopifyBefore * 100) / 100;
  const diff = Math.round((target - before) * 100) / 100;

  // 2. No-op if already in sync
  if (Math.abs(diff) < 0.005) {
    return { ok: true, shopify_before: before, shopify_after: before, diff_applied: 0 };
  }

  // 3. Push diff to Shopify (credit if positive, debit if negative)
  try {
    if (diff > 0) {
      await giftCardCredit(args.giftCardId, diff.toFixed(2), args.noteForShopify);
    } else {
      await giftCardDebit(args.giftCardId, Math.abs(diff).toFixed(2), args.noteForShopify);
    }
    return {
      ok: true,
      shopify_before: before,
      shopify_after: target,
      diff_applied: diff,
    };
  } catch (e) {
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'sync_to_total_push',
      entity_id: args.customerIdForLog,
      ok: false,
      error_message: (e as Error).message,
      request_body: {
        gift_card_id: args.giftCardId,
        new_app_total: target,
        shopify_before: before,
        diff,
      },
    });
    return {
      ok: false,
      shopify_before: before,
      shopify_after: before,
      diff_applied: 0,
      error: (e as Error).message,
    };
  }
}

export interface ExpireResult {
  email: string;
  customer_id: string;
  prior_balance: number;
  new_balance: number;
  shopify_debited: number;
  ok: boolean;
  error?: string;
}

/**
 * Expire ALL active balance for one customer:
 *   - Sum remaining_amount of all active grants
 *   - Debit the Shopify gift card by that total
 *   - Mark all active grants as expired (status='expired', remaining_amount=0)
 *   - Insert ledger 'expire' rows
 *   - Update Klaviyo loyalty_card_balance to 0
 */
export async function expireCustomerBalance(
  customerId: string,
  reason = 'Manual expire',
  actor?: { id: string; email?: string | null },
  options?: { skipShopify?: boolean }
): Promise<ExpireResult> {
  const supabase = createSupabaseServiceClient();

  const { data: customer, error: cErr } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id, klaviyo_profile_id')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr || !customer) {
    return { email: '?', customer_id: customerId, prior_balance: 0, new_balance: 0, shopify_debited: 0, ok: false, error: cErr?.message ?? 'customer not found' };
  }

  const priorBalance = Number(customer.total_balance_cached ?? 0);
  if (priorBalance <= 0) {
    return { email: customer.email, customer_id: customerId, prior_balance: 0, new_balance: 0, shopify_debited: 0, ok: true };
  }

  // 1. Mark active grants expired in our DB FIRST. We've moved away from
  // "push delta to Shopify" — the new model is sync-to-total: update DB,
  // then bring Shopify to whatever DB says it should be (here: $0).
  const { data: activeGrants } = await supabase
    .from('grants')
    .select('id, remaining_amount')
    .eq('customer_id', customer.id)
    .eq('status', 'active');

  if (activeGrants && activeGrants.length > 0) {
    const ids = activeGrants.map((g) => g.id);
    await supabase
      .from('grants')
      .update({ status: 'expired', remaining_amount: 0, expired_at: new Date().toISOString() })
      .in('id', ids);

    // Ledger entries (one per grant, captures original remaining_amount)
    const ledgerRows = activeGrants
      .filter((g) => Number(g.remaining_amount) > 0)
      .map((g) => ({
        customer_id: customer.id,
        grant_id: g.id,
        type: 'expire' as const,
        amount: -Number(g.remaining_amount),
        description: reason,
        created_by: actor?.id ?? null,
        created_by_email: actor?.email ?? null,
      }));
    if (ledgerRows.length) {
      await supabase.from('ledger').insert(ledgerRows);
    }
  }

  // 2. Recompute balance (should now be $0)
  const newBalance = await recomputeBalance(customer.id);

  // 3. Sync Shopify to the new app total ($0 after expire). Sync-to-total
  // semantics: fetch Shopify, compute diff vs target ($0), debit by the diff.
  // If Shopify was already at $0 (or wasn't in sync at all), this still does
  // the right thing by ending Shopify at $0.
  let debited = 0;
  if (!options?.skipShopify && customer.shopify_gift_card_id) {
    const sync = await syncShopifyToTarget({
      giftCardId: customer.shopify_gift_card_id,
      newAppTotal: newBalance,
      noteForShopify: `${reason} — sync to $${newBalance.toFixed(2)}`,
      customerIdForLog: customer.id,
    });
    if (!sync.ok) {
      return {
        email: customer.email,
        customer_id: customerId,
        prior_balance: priorBalance,
        new_balance: newBalance,
        shopify_debited: 0,
        ok: false,
        error: `Shopify: ${sync.error}`,
      };
    }
    // diff_applied is negative when we debited (which is the expected case here)
    debited = -sync.diff_applied;
  }

  // Push to Klaviyo in the background — don't block on Klaviyo's sometimes-slow
  // profile API. The retry helper handles its own retry/timeout/logging.
  waitUntil(
    upsertProfileWithRetry({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_balance: newBalance,
        loyalty_card_code: customer.loyalty_card_code ?? undefined,
      },
      customer_id_for_log: customer.id,
      reason: `manual-expire (${reason})`,
    })
  );

  return { email: customer.email, customer_id: customerId, prior_balance: priorBalance, new_balance: newBalance, shopify_debited: debited, ok: true };
}

/**
 * Auto-expire any grant whose expires_on is past the cutoff (default = today).
 * Per customer: sums all eligible grants, debits Shopify ONCE for the total,
 * marks all those grants expired in our DB, writes one ledger row per grant,
 * recomputes the customer's balance, and pushes the new balance to Klaviyo.
 *
 * Idempotent — safe to run multiple times. Designed to be triggered daily by
 * Vercel Cron, with an admin-callable button for manual catch-up.
 */
export interface AutoExpireResult {
  cutoff_date: string;
  customers_processed: number;
  grants_expired: number;
  total_amount_expired: number;
  duration_ms: number;
  errors: Array<{ email: string; error: string }>;
}

export async function expireGrantsPastDate(args: {
  cutoffISO?: string;       // YYYY-MM-DD; default today (local UTC date)
  actorEmail?: string;      // who triggered this (for audit)
}): Promise<AutoExpireResult> {
  const t0 = Date.now();
  const cutoff = args.cutoffISO ?? new Date().toISOString().slice(0, 10);
  const supabase = createSupabaseServiceClient();

  // 1. Find every active grant past the cutoff with a positive remaining amount
  const expiredGrants: Array<{
    id: string;
    customer_id: string;
    remaining_amount: number;
    expires_on: string;
  }> = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('grants')
      .select('id, customer_id, remaining_amount, expires_on')
      .eq('status', 'active')
      .lt('expires_on', cutoff)
      .gt('remaining_amount', 0)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`grants query: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const g of data) {
      expiredGrants.push({
        id: g.id,
        customer_id: g.customer_id,
        remaining_amount: Number(g.remaining_amount),
        expires_on: g.expires_on,
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (expiredGrants.length === 0) {
    return {
      cutoff_date: cutoff,
      customers_processed: 0,
      grants_expired: 0,
      total_amount_expired: 0,
      duration_ms: Date.now() - t0,
      errors: [],
    };
  }

  // 2. Group grants by customer
  const byCustomer = new Map<string, typeof expiredGrants>();
  for (const g of expiredGrants) {
    const list = byCustomer.get(g.customer_id) ?? [];
    list.push(g);
    byCustomer.set(g.customer_id, list);
  }

  const errors: Array<{ email: string; error: string }> = [];
  let totalExpired = 0;
  let grantsExpired = 0;
  let customersProcessed = 0;

  // 3. Process each customer with controlled concurrency
  const CONCURRENCY = 5;
  const customerEntries = Array.from(byCustomer.entries());

  async function processCustomer(customerId: string, grants: typeof expiredGrants): Promise<void> {
    // Pull customer details
    const { data: customer, error: cErr } = await supabase
      .from('customers')
      .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id')
      .eq('id', customerId)
      .maybeSingle();
    if (cErr || !customer) {
      errors.push({ email: '?', error: cErr?.message ?? 'customer not found' });
      return;
    }

    const totalToDebit = grants.reduce((s, g) => s + g.remaining_amount, 0);

    // 3a. Debit Shopify once for the total
    if (customer.shopify_gift_card_id && totalToDebit > 0) {
      try {
        const earliestExpiry = grants.map((g) => g.expires_on).sort()[0];
        await giftCardDebit(
          customer.shopify_gift_card_id,
          totalToDebit.toFixed(2),
          `Auto-expire: ${grants.length} grant(s) past ${earliestExpiry}`
        );
      } catch (e) {
        await supabase.from('sync_log').insert({
          target: 'shopify',
          operation: 'auto_expire_debit',
          entity_id: customer.id,
          ok: false,
          error_message: (e as Error).message,
          request_body: { totalToDebit, grant_ids: grants.map((g) => g.id) },
        });
        errors.push({ email: customer.email, error: `Shopify: ${(e as Error).message}` });
        return;
      }
    }

    // 3b. Mark grants expired (one bulk update)
    const grantIds = grants.map((g) => g.id);
    const { error: gErr } = await supabase
      .from('grants')
      .update({ status: 'expired', remaining_amount: 0, expired_at: new Date().toISOString() })
      .in('id', grantIds);
    if (gErr) {
      errors.push({ email: customer.email, error: `grants update: ${gErr.message}` });
      return;
    }

    // 3c. Insert ledger rows (one per grant)
    const ledgerRows = grants.map((g) => ({
      customer_id: customer.id,
      grant_id: g.id,
      type: 'expire' as const,
      amount: -g.remaining_amount,
      description: `Auto-expire — past expires_on ${g.expires_on}`,
      created_by_email: args.actorEmail ?? 'cron',
    }));
    await supabase.from('ledger').insert(ledgerRows);

    // 3d. Recompute cached balance + next-expiration
    const newBalance = await recomputeBalance(customer.id);
    const { data: nextActive } = await supabase
      .from('grants')
      .select('expires_on')
      .eq('customer_id', customer.id)
      .eq('status', 'active')
      .order('expires_on', { ascending: true })
      .limit(1)
      .maybeSingle();
    await supabase
      .from('customers')
      .update({
        total_balance_cached: newBalance,
        expiration_date: nextActive?.expires_on ?? null,
      })
      .eq('id', customer.id);

    // 3e. Push new balance + expiration_date to Klaviyo
    try {
      await upsertProfile({
        email: customer.email,
        first_name: customer.first_name ?? undefined,
        last_name: customer.last_name ?? undefined,
        properties: {
          loyalty_card_balance: newBalance,
          loyalty_card_code: customer.loyalty_card_code ?? undefined,
          expiration_date: nextActive?.expires_on ?? '',
        },
      });
    } catch {/* non-fatal */}

    totalExpired += totalToDebit;
    grantsExpired += grants.length;
    customersProcessed += 1;
  }

  for (let i = 0; i < customerEntries.length; i += CONCURRENCY) {
    const slice = customerEntries.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(([id, grants]) => processCustomer(id, grants)));
  }

  return {
    cutoff_date: cutoff,
    customers_processed: customersProcessed,
    grants_expired: grantsExpired,
    total_amount_expired: Math.round(totalExpired * 100) / 100,
    duration_ms: Date.now() - t0,
    errors,
  };
}

/**
 * Apply a manual adjustment (credit or debit) to a customer's balance.
 *   amount > 0 → credit (add) the customer's gift card
 *   amount < 0 → debit (remove) — reduces FIFO from active grants
 */
export async function adjustCustomerBalance(args: {
  customerId: string;
  amount: number;            // positive credit, negative debit
  reason: string;
  expiresOn?: string;        // YYYY-MM-DD; only used for credits, default 1y from today
  actor?: { id: string; email?: string | null };
  skipShopify?: boolean;     // when true, only update our DB + Klaviyo
}): Promise<{ ok: boolean; new_balance: number; error?: string }> {
  const { customerId, amount, reason } = args;
  if (amount === 0) return { ok: false, new_balance: 0, error: 'amount must be nonzero' };

  const supabase = createSupabaseServiceClient();
  const { data: customer, error: cErr } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id, klaviyo_profile_id')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr || !customer) return { ok: false, new_balance: 0, error: cErr?.message ?? 'customer not found' };

  // Only require a linked Shopify gift card if we plan to actually call Shopify
  if (!args.skipShopify && !customer.shopify_gift_card_id) {
    return { ok: false, new_balance: 0, error: 'Customer has no linked Shopify gift card' };
  }

  // ----- DB updates first (sync-to-total model) -----
  // We update the DB to reflect the new desired balance, then sync Shopify
  // to that new total below. Order is intentionally DB-first so the resulting
  // Shopify balance always converges on the app's truth, regardless of any
  // prior drift between the two systems.

  if (amount > 0) {
    // Credit: create a synthetic grant on the "Manual Adjustments" event
    const { data: ev } = await supabase
      .from('events')
      .select('id')
      .eq('name', 'Manual Adjustments')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    let eventId = ev?.id;
    if (!eventId) {
      const { data: created } = await supabase
        .from('events')
        .insert({ name: 'Manual Adjustments', host: 'Manual', status: 'completed', kind: 'system' })
        .select('id')
        .single();
      eventId = created!.id;
    }

    const expiresOn = args.expiresOn ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Link the grant to the customer's Shopify card (if any) so reconcile
    // tools and future syncs can find it. Falls back to NULL if customer
    // has no card yet (rare; shouldn't happen since we required one above
    // when skipShopify is off).
    const { data: grant } = await supabase
      .from('grants')
      .insert({
        customer_id: customer.id,
        event_id: eventId,
        initial_amount: amount,
        remaining_amount: amount,
        expires_on: expiresOn,
        reason: 'Manual',
        note: reason,
        status: 'active',
        shopify_gift_card_id: customer.shopify_gift_card_id ?? null,
        shopify_gift_card_code: customer.loyalty_card_code ?? null,
      })
      .select('id')
      .single();

    await supabase.from('ledger').insert({
      customer_id: customer.id,
      grant_id: grant?.id ?? null,
      type: 'adjust',
      amount,
      description: reason,
      created_by: args.actor?.id ?? null,
      created_by_email: args.actor?.email ?? null,
    });
  } else {
    // Debit: FIFO across active grants
    const debit = Math.abs(amount);
    let remaining = debit;
    const { data: activeGrants } = await supabase
      .from('grants')
      .select('id, remaining_amount')
      .eq('customer_id', customer.id)
      .eq('status', 'active')
      .order('expires_on', { ascending: true });

    for (const g of activeGrants ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(Number(g.remaining_amount), remaining);
      const newRemaining = Number(g.remaining_amount) - take;
      const newStatus = newRemaining <= 0 ? 'fully_redeemed' : 'active';
      await supabase
        .from('grants')
        .update({ remaining_amount: newRemaining, status: newStatus })
        .eq('id', g.id);
      await supabase.from('ledger').insert({
        customer_id: customer.id,
        grant_id: g.id,
        type: 'adjust',
        amount: -take,
        description: reason,
        created_by: args.actor?.id ?? null,
        created_by_email: args.actor?.email ?? null,
      });
      remaining -= take;
    }
  }

  // Recompute the new app total from grants (truth)
  const newBalance = await recomputeBalance(customer.id);

  // Sync-to-total: bring Shopify to the new app total. If they were drifted,
  // this resolves it in DB's favor (which is the user's intent — the manual
  // adjust is a deliberate "make Shopify match this number" action).
  if (!args.skipShopify && customer.shopify_gift_card_id) {
    const sync = await syncShopifyToTarget({
      giftCardId: customer.shopify_gift_card_id,
      newAppTotal: newBalance,
      noteForShopify: `${reason} — sync to $${newBalance.toFixed(2)}`,
      customerIdForLog: customer.id,
    });
    if (!sync.ok) {
      // DB is already updated. Return the error so the UI can surface it.
      // The next reconcile run will catch and resolve any residual drift.
      return {
        ok: false,
        new_balance: newBalance,
        error: `Shopify: ${sync.error} (DB updated but Shopify sync failed; run reconcile to resolve)`,
      };
    }
  }

  // Background Klaviyo push (3-attempt retry with growing timeouts; logs every
  // attempt to sync_log; terminal failure surfaces in the in-app banner).
  waitUntil(
    upsertProfileWithRetry({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_balance: newBalance,
        loyalty_card_code: customer.loyalty_card_code ?? undefined,
        last_reward: amount > 0 ? amount : undefined,
      },
      customer_id_for_log: customer.id,
      reason: `manual-adjust (${reason})`,
    })
  );

  return { ok: true, new_balance: newBalance };
}
