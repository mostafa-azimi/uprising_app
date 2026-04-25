/**
 * Apply a redemption (debit) against a customer's grants in our DB, FIFO by
 * earliest expiration. The actual gift card balance has already been reduced
 * by Shopify at checkout — we're just bringing our DB in sync.
 *
 * This is shared between the webhook and the manual reconciliation tool.
 */

import { createSupabaseServiceClient } from './supabase/server';
import { upsertProfile } from './klaviyo';
import { recomputeBalance } from './customers';

export interface RedemptionResult {
  email: string;
  customer_id: string;
  redeemed: number;
  prior_balance: number;
  new_balance: number;
  ok: boolean;
  error?: string;
}

/**
 * Apply a redemption against the customer's active grants, oldest expiration first.
 * Writes ledger rows for each touched grant, updates remaining_amount/status,
 * recomputes total_balance_cached, and pushes the new loyalty_card_balance to Klaviyo.
 *
 * Idempotent on shopify_order_id — if a ledger row already exists for the same
 * order, we skip (so duplicate webhook deliveries don't double-debit).
 */
export async function applyRedemption(args: {
  customerId: string;
  amount: number;
  shopifyOrderId?: string;
  description?: string;
}): Promise<RedemptionResult> {
  const supabase = createSupabaseServiceClient();
  const { customerId } = args;
  const amount = Math.abs(Number(args.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { email: '?', customer_id: customerId, redeemed: 0, prior_balance: 0, new_balance: 0, ok: false, error: 'invalid amount' };
  }

  const { data: customer, error: cErr } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr || !customer) {
    return { email: '?', customer_id: customerId, redeemed: 0, prior_balance: 0, new_balance: 0, ok: false, error: cErr?.message ?? 'customer not found' };
  }

  const priorBalance = Number(customer.total_balance_cached ?? 0);

  // Idempotency: if we've already recorded this order, skip
  if (args.shopifyOrderId) {
    const { data: existing } = await supabase
      .from('ledger')
      .select('id')
      .eq('shopify_order_id', args.shopifyOrderId)
      .eq('customer_id', customer.id)
      .limit(1);
    if (existing && existing.length > 0) {
      return { email: customer.email, customer_id: customerId, redeemed: 0, prior_balance: priorBalance, new_balance: priorBalance, ok: true };
    }
  }

  // Walk active grants oldest-expires-first, debit until the redemption is satisfied
  const { data: grants } = await supabase
    .from('grants')
    .select('id, remaining_amount')
    .eq('customer_id', customer.id)
    .eq('status', 'active')
    .order('expires_on', { ascending: true });

  let remaining = amount;
  for (const g of grants ?? []) {
    if (remaining <= 0) break;
    const grantRemaining = Number(g.remaining_amount);
    if (grantRemaining <= 0) continue;
    const take = Math.min(grantRemaining, remaining);
    const newRemaining = grantRemaining - take;
    const newStatus = newRemaining <= 0 ? 'fully_redeemed' : 'active';

    await supabase
      .from('grants')
      .update({ remaining_amount: newRemaining, status: newStatus })
      .eq('id', g.id);

    await supabase.from('ledger').insert({
      customer_id: customer.id,
      grant_id: g.id,
      type: 'redeem',
      amount: -take,
      shopify_order_id: args.shopifyOrderId ?? null,
      description: args.description ?? 'Shopify redemption',
    });

    remaining -= take;
  }

  // If remaining > 0, the redemption exceeds our tracked balance. That can happen if
  // Rise issued credit before we started tracking. Record the leftover as an unmatched
  // redemption ledger entry without a grant_id so it shows up in audits.
  if (remaining > 0.0001) {
    await supabase.from('ledger').insert({
      customer_id: customer.id,
      grant_id: null,
      type: 'redeem',
      amount: -remaining,
      shopify_order_id: args.shopifyOrderId ?? null,
      description: (args.description ?? 'Shopify redemption') + ` (unmatched: $${remaining.toFixed(2)})`,
    });
  }

  const newBalance = await recomputeBalance(customer.id);

  // Push new balance to Klaviyo
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
      operation: 'profile_property_sync_redeem',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

  return {
    email: customer.email,
    customer_id: customerId,
    redeemed: amount,
    prior_balance: priorBalance,
    new_balance: newBalance,
    ok: true,
  };
}
