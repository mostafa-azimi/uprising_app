import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import {
  paginatePaidOrdersSince,
  getOrderTransactions,
  type ShopifyOrderSummary,
  type ShopifyOrderTransaction,
} from '@/lib/shopify';
import { applyRedemption } from '@/lib/redemptions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Backfill redemptions from Shopify paid orders.
 *
 * For each paid order in the date range, we look at the gift_card-gateway
 * transactions, find the matching customer/grant in our DB, and run the
 * same logic as the webhook. Idempotent: if a ledger row already exists
 * for the order, we skip.
 *
 * Runs everything that the orders/paid webhook would have run, including
 * writing to redemption_orders for revenue attribution.
 */

interface ProcessedOrder {
  order_id: string;
  order_name: string;
  email: string | null;
  gift_card_amount: number;
  order_total: number;
  status: 'redeemed' | 'already_processed' | 'no_customer' | 'no_gift_card_txn' | 'error';
  detail?: string;
}

interface BackfillResult {
  ok: boolean;
  since: string;
  until: string | null;
  orders_fetched: number;
  orders_with_gift_card_txns: number;
  orders_redeemed: number;
  orders_already_processed: number;
  orders_no_customer: number;
  orders_errored: number;
  total_redeemed_amount: number;
  duration_ms: number;
  processed: ProcessedOrder[];
  message?: string;
}

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'backfill-redemptions', level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  try {
    try {
      await requireAdmin();
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as { since?: string; until?: string };
    const sinceParam = body.since?.trim();
    const untilParam = body.until?.trim();
    if (!sinceParam) {
      return NextResponse.json({ error: 'since is required (ISO date)' }, { status: 400 });
    }

    // Validate dates
    const sinceDate = new Date(sinceParam);
    if (isNaN(sinceDate.getTime())) {
      return NextResponse.json({ error: `Invalid since date: ${sinceParam}` }, { status: 400 });
    }
    const sinceISO = sinceDate.toISOString();
    let untilISO: string | null = null;
    if (untilParam) {
      const untilDate = new Date(untilParam);
      if (isNaN(untilDate.getTime())) {
        return NextResponse.json({ error: `Invalid until date: ${untilParam}` }, { status: 400 });
      }
      untilISO = untilDate.toISOString();
    }

    log('info', 'started', { since: sinceISO, until: untilISO });

    const supabase = createSupabaseServiceClient();
    const result: BackfillResult = {
      ok: true,
      since: sinceISO,
      until: untilISO,
      orders_fetched: 0,
      orders_with_gift_card_txns: 0,
      orders_redeemed: 0,
      orders_already_processed: 0,
      orders_no_customer: 0,
      orders_errored: 0,
      total_redeemed_amount: 0,
      duration_ms: 0,
      processed: [],
    };

    let orders: ShopifyOrderSummary[];
    try {
      orders = await paginatePaidOrdersSince({ sinceISO, untilISO: untilISO ?? undefined, maxPages: 20 });
      result.orders_fetched = orders.length;
      log('info', 'orders_fetched', { count: orders.length });
    } catch (e) {
      log('error', 'orders_fetch_failed', { error: (e as Error).message });
      return NextResponse.json(
        { error: `Failed to fetch orders from Shopify: ${(e as Error).message}` },
        { status: 502 }
      );
    }

    // Process each order — fetch its transactions, look for gift_card sales
    for (const order of orders) {
      const orderGid = order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;
      const email = (order.customer?.email ?? order.email ?? '').trim().toLowerCase() || null;

      let txns: ShopifyOrderTransaction[];
      try {
        txns = await getOrderTransactions(order.id);
      } catch (e) {
        result.orders_errored++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: 0,
          order_total: 0,
          status: 'error',
          detail: `transactions fetch: ${(e as Error).message}`,
        });
        continue;
      }

      const giftCardTxns = txns.filter(
        (t) => (t.gateway ?? '').toLowerCase() === 'gift_card'
            && (t.status ?? '').toLowerCase() === 'success'
            && (t.kind ?? '').toLowerCase() === 'sale'
      );
      const totalGiftCardRedeemed = giftCardTxns.reduce((s, t) => s + Number(t.amount ?? 0), 0);

      if (giftCardTxns.length === 0 || totalGiftCardRedeemed <= 0) {
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: 0,
          order_total: Number(order.total_price ?? 0),
          status: 'no_gift_card_txn',
        });
        continue;
      }
      result.orders_with_gift_card_txns++;

      // Compute order totals from the success-sale transactions (consistent with webhook)
      const allSales = txns.filter(
        (t) => (t.kind ?? '').toLowerCase() === 'sale' && (t.status ?? '').toLowerCase() === 'success'
      );
      const orderTotal = allSales.reduce((s, t) => s + Number(t.amount ?? 0), 0);
      const otherAmount = orderTotal - totalGiftCardRedeemed;

      // Find customer: first by gift_card_id → grants → customers, then by email
      const giftCardIds = giftCardTxns
        .map((t) => t.receipt?.gift_card_id)
        .filter((x): x is number | string => x !== null && x !== undefined)
        .map((x) => `gid://shopify/GiftCard/${x}`);

      let customerId: string | null = null;

      if (giftCardIds.length > 0) {
        const { data: g } = await supabase
          .from('grants')
          .select('customer_id')
          .in('shopify_gift_card_id', giftCardIds)
          .limit(1);
        if (g && g.length > 0) customerId = g[0].customer_id;

        if (!customerId) {
          const { data: c } = await supabase
            .from('customers')
            .select('id')
            .in('shopify_gift_card_id', giftCardIds)
            .limit(1);
          if (c && c.length > 0) customerId = c[0].id;
        }
      }

      if (!customerId && email) {
        const { data } = await supabase
          .from('customers')
          .select('id')
          .eq('email', email)
          .maybeSingle();
        if (data) customerId = data.id;
      }

      if (!customerId) {
        result.orders_no_customer++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          status: 'no_customer',
          detail: `gift_card_ids=${giftCardIds.length}`,
        });
        continue;
      }

      // Idempotency: skip if we've already recorded this order's redemption
      const { data: existingLedger } = await supabase
        .from('ledger')
        .select('id')
        .eq('shopify_order_id', orderGid)
        .eq('customer_id', customerId)
        .limit(1);
      if (existingLedger && existingLedger.length > 0) {
        // Still upsert redemption_orders so revenue attribution stays accurate
        await supabase.from('redemption_orders').upsert({
          customer_id: customerId,
          shopify_order_id: orderGid,
          order_total: orderTotal,
          gift_card_amount: totalGiftCardRedeemed,
          other_amount: otherAmount,
          raw_transactions: txns as unknown as Record<string, unknown>,
        }, { onConflict: 'shopify_order_id' });
        result.orders_already_processed++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          status: 'already_processed',
        });
        continue;
      }

      // Upsert revenue attribution snapshot
      try {
        await supabase.from('redemption_orders').upsert({
          customer_id: customerId,
          shopify_order_id: orderGid,
          order_total: orderTotal,
          gift_card_amount: totalGiftCardRedeemed,
          other_amount: otherAmount,
          raw_transactions: txns as unknown as Record<string, unknown>,
        }, { onConflict: 'shopify_order_id' });
      } catch (e) {
        log('warn', 'redemption_orders_upsert_failed', { order_id: orderGid, error: (e as Error).message });
      }

      // Apply the debit (writes ledger, updates grants, recomputes balance, pushes Klaviyo)
      try {
        const r = await applyRedemption({
          customerId,
          amount: totalGiftCardRedeemed,
          shopifyOrderId: orderGid,
          shopifyGiftCardId: giftCardIds[0] ?? undefined,
          description: `Shopify order redemption (backfill)${email ? ' — ' + email : ''}`,
        });
        if (r.ok) {
          result.orders_redeemed++;
          result.total_redeemed_amount += totalGiftCardRedeemed;
          result.processed.push({
            order_id: orderGid,
            order_name: order.name,
            email,
            gift_card_amount: totalGiftCardRedeemed,
            order_total: orderTotal,
            status: 'redeemed',
            detail: `prior=$${r.prior_balance.toFixed(2)} → new=$${r.new_balance.toFixed(2)}`,
          });
        } else {
          result.orders_errored++;
          result.processed.push({
            order_id: orderGid,
            order_name: order.name,
            email,
            gift_card_amount: totalGiftCardRedeemed,
            order_total: orderTotal,
            status: 'error',
            detail: r.error ?? 'applyRedemption returned ok=false',
          });
        }
      } catch (e) {
        result.orders_errored++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          status: 'error',
          detail: (e as Error).message,
        });
      }
    }

    result.total_redeemed_amount = Math.round(result.total_redeemed_amount * 100) / 100;
    result.duration_ms = Date.now() - t0;
    log('info', 'completed', {
      duration_ms: result.duration_ms,
      orders_fetched: result.orders_fetched,
      orders_redeemed: result.orders_redeemed,
      total_redeemed_amount: result.total_redeemed_amount,
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
