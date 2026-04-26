/**
 * Expire / adjust balance helpers — used by single-customer and bulk actions.
 */

import { createSupabaseServiceClient } from './supabase/server';
import { giftCardCredit, giftCardDebit } from './shopify';
import { upsertProfile } from './klaviyo';
import { recomputeBalance } from './customers';

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
export async function expireCustomerBalance(customerId: string, reason = 'Manual expire', actor?: { id: string; email?: string | null }): Promise<ExpireResult> {
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

  // 1. Debit Shopify
  let debited = 0;
  if (customer.shopify_gift_card_id) {
    try {
      await giftCardDebit(customer.shopify_gift_card_id, priorBalance.toFixed(2), `${reason} — full balance expire`);
      debited = priorBalance;
    } catch (e) {
      await supabase.from('sync_log').insert({
        target: 'shopify',
        operation: 'giftCardDebit_expire',
        entity_id: customer.id,
        ok: false,
        error_message: (e as Error).message,
        request_body: { amount: priorBalance, reason },
      });
      return { email: customer.email, customer_id: customerId, prior_balance: priorBalance, new_balance: priorBalance, shopify_debited: 0, ok: false, error: `Shopify: ${(e as Error).message}` };
    }
  }

  // 2. Mark active grants as expired
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

    // 3. Ledger entries
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
  } else if (debited > 0) {
    // No grants in our DB but customer had a Shopify balance (e.g. unmigrated card).
    // Still write a single adjust ledger row so the activity is recorded.
    await supabase.from('ledger').insert({
      customer_id: customer.id,
      grant_id: null,
      type: 'expire',
      amount: -debited,
      description: `${reason} (no local grants — Shopify balance expired directly)`,
      created_by: actor?.id ?? null,
      created_by_email: actor?.email ?? null,
    });
  }

  // 4. Recompute balance + sync Klaviyo
  const newBalance = await recomputeBalance(customer.id);

  try {
    await upsertProfile({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_balance: newBalance,
        loyalty_card_code: customer.loyalty_card_code ?? undefined,
      },
    });
  } catch (e) {
    await supabase.from('sync_log').insert({
      target: 'klaviyo',
      operation: 'profile_property_sync_expire',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

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

  if (!customer.shopify_gift_card_id) {
    return { ok: false, new_balance: 0, error: 'Customer has no linked Shopify gift card' };
  }

  if (amount > 0) {
    // Credit path — add to gift card and create a synthetic grant
    try {
      await giftCardCredit(customer.shopify_gift_card_id, amount.toFixed(2), reason);
    } catch (e) {
      return { ok: false, new_balance: Number(customer.total_balance_cached ?? 0), error: `Shopify: ${(e as Error).message}` };
    }

    // Find or create a "Manual Adjustments" event
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
    // Debit path — reduce FIFO from active grants
    const debit = Math.abs(amount);
    try {
      await giftCardDebit(customer.shopify_gift_card_id, debit.toFixed(2), reason);
    } catch (e) {
      return { ok: false, new_balance: Number(customer.total_balance_cached ?? 0), error: `Shopify: ${(e as Error).message}` };
    }

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

  const newBalance = await recomputeBalance(customer.id);

  try {
    await upsertProfile({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_balance: newBalance,
        loyalty_card_code: customer.loyalty_card_code ?? undefined,
        last_reward: amount > 0 ? amount : undefined,
      },
    });
  } catch {
    /* non-fatal */
  }

  return { ok: true, new_balance: newBalance };
}
