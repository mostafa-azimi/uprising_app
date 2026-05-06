import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import {
  paginatePaidOrdersSince,
  getOrderTransactions,
  type ShopifyOrderSummary,
  type ShopifyOrderTransaction,
} from '@/lib/shopify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Attribute paid Shopify orders to events — READ ONLY for loyalty data.
 *
 * For each paid order in the date range:
 *   1. Fetch its transactions, find gift_card success-sale txns
 *   2. Map gift_card_id → grant.shopify_gift_card_id → grants.event_id
 *   3. Look up the customer (by gift_card_id or email)
 *   4. Upsert a row in `redemption_orders` with `event_id` set
 *
 * What this DOES NOT touch:
 *   - ledger (no entries written)
 *   - grants (no balance changes, no status updates)
 *   - customers.total_balance_cached
 *   - Klaviyo (no profile pushes)
 *   - Shopify (no gift card mutations)
 *
 * The point: see attribution numbers on event detail pages without disturbing
 * an already-reconciled loyalty/gift card system.
 */

interface ProcessedOrder {
  order_id: string;
  order_name: string;
  email: string | null;
  gift_card_amount: number;
  order_total: number;
  other_amount: number;
  event_id: string | null;
  event_name: string | null;
  status: 'attributed' | 'no_event_match' | 'no_customer' | 'no_gift_card_txn' | 'error';
  detail?: string;
}

interface AttributeResult {
  ok: boolean;
  since: string;
  until: string | null;
  orders_fetched: number;
  orders_with_gift_card_txns: number;
  orders_attributed: number;
  orders_no_event_match: number;
  orders_no_customer: number;
  orders_errored: number;
  total_attributed_gift_card: number;
  total_attributed_revenue: number;
  duration_ms: number;
  processed: ProcessedOrder[];
}

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'attribute-orders', level, event, ts: new Date().toISOString(), ...data };
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

    const body = (await request.json().catch(() => ({}))) as {
      since?: string;
      until?: string;
    };
    const sinceParam = body.since?.trim();
    const untilParam = body.until?.trim();
    if (!sinceParam) {
      return NextResponse.json({ error: 'since is required (ISO date)' }, { status: 400 });
    }

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
    const result: AttributeResult = {
      ok: true,
      since: sinceISO,
      until: untilISO,
      orders_fetched: 0,
      orders_with_gift_card_txns: 0,
      orders_attributed: 0,
      orders_no_event_match: 0,
      orders_no_customer: 0,
      orders_errored: 0,
      total_attributed_gift_card: 0,
      total_attributed_revenue: 0,
      duration_ms: 0,
      processed: [],
    };

    let orders: ShopifyOrderSummary[];
    try {
      orders = await paginatePaidOrdersSince({
        sinceISO,
        untilISO: untilISO ?? undefined,
        maxPages: 20,
      });
      result.orders_fetched = orders.length;
      log('info', 'orders_fetched', { count: orders.length });
    } catch (e) {
      log('error', 'orders_fetch_failed', { error: (e as Error).message });
      return NextResponse.json(
        { error: `Failed to fetch orders from Shopify: ${(e as Error).message}` },
        { status: 502 }
      );
    }

    // Cache event names so we don't re-query for each order in the same event
    const eventNameById = new Map<string, string>();
    async function getEventName(eventId: string): Promise<string> {
      if (eventNameById.has(eventId)) return eventNameById.get(eventId) as string;
      const { data } = await supabase.from('events').select('name').eq('id', eventId).maybeSingle();
      const name = data?.name ?? '(unknown event)';
      eventNameById.set(eventId, name);
      return name;
    }

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
          other_amount: 0,
          event_id: null,
          event_name: null,
          status: 'error',
          detail: `transactions fetch: ${(e as Error).message}`,
        });
        continue;
      }

      const giftCardTxns = txns.filter(
        (t) =>
          (t.gateway ?? '').toLowerCase() === 'gift_card' &&
          (t.status ?? '').toLowerCase() === 'success' &&
          (t.kind ?? '').toLowerCase() === 'sale'
      );
      const totalGiftCardRedeemed = giftCardTxns.reduce(
        (s, t) => s + Number(t.amount ?? 0),
        0
      );

      if (giftCardTxns.length === 0 || totalGiftCardRedeemed <= 0) {
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: 0,
          order_total: Number(order.total_price ?? 0),
          other_amount: 0,
          event_id: null,
          event_name: null,
          status: 'no_gift_card_txn',
        });
        continue;
      }
      result.orders_with_gift_card_txns++;

      const allSales = txns.filter(
        (t) =>
          (t.kind ?? '').toLowerCase() === 'sale' &&
          (t.status ?? '').toLowerCase() === 'success'
      );
      const orderTotal = allSales.reduce((s, t) => s + Number(t.amount ?? 0), 0);
      const otherAmount = orderTotal - totalGiftCardRedeemed;

      // Resolve gift card IDs the customer used
      const giftCardIds = giftCardTxns
        .map((t) => t.receipt?.gift_card_id)
        .filter((x): x is number | string => x !== null && x !== undefined)
        .map((x) => `gid://shopify/GiftCard/${x}`);

      // Look up the grant whose gift card matches → that grant's event_id is
      // our attribution. Picks the OLDEST active grant if multiple match
      // (matches FIFO debit order).
      let eventId: string | null = null;
      let customerId: string | null = null;
      if (giftCardIds.length > 0) {
        const { data: g } = await supabase
          .from('grants')
          .select('customer_id, event_id, created_at')
          .in('shopify_gift_card_id', giftCardIds)
          .order('created_at', { ascending: true })
          .limit(1);
        if (g && g.length > 0) {
          customerId = g[0].customer_id;
          eventId = g[0].event_id;
        }

        // Customer fallback if grant lookup didn't find anything
        if (!customerId) {
          const { data: c } = await supabase
            .from('customers')
            .select('id')
            .in('shopify_gift_card_id', giftCardIds)
            .limit(1);
          if (c && c.length > 0) customerId = c[0].id;
        }
      }

      // Email fallback to find the customer
      if (!customerId && email) {
        const { data } = await supabase
          .from('customers')
          .select('id')
          .eq('email', email)
          .maybeSingle();
        if (data) customerId = data.id;
      }

      // If we have a customer but no event_id yet, try customer's oldest active
      // grant as the attribution target.
      if (customerId && !eventId) {
        const { data: g } = await supabase
          .from('grants')
          .select('event_id')
          .eq('customer_id', customerId)
          .eq('status', 'active')
          .order('created_at', { ascending: true })
          .limit(1);
        if (g && g.length > 0 && g[0].event_id) eventId = g[0].event_id;
      }

      if (!customerId) {
        result.orders_no_customer++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          other_amount: otherAmount,
          event_id: null,
          event_name: null,
          status: 'no_customer',
        });
        continue;
      }

      if (!eventId) {
        // Still upsert redemption_orders so the attribution snapshot exists for
        // the customer; just no event_id (won't show on event pages, but sums
        // remain visible in /ledger / customer detail flows).
        try {
          await supabase
            .from('redemption_orders')
            .upsert(
              {
                customer_id: customerId,
                shopify_order_id: orderGid,
                order_total: orderTotal,
                gift_card_amount: totalGiftCardRedeemed,
                other_amount: otherAmount,
                event_id: null,
                raw_transactions: txns as unknown as Record<string, unknown>,
              },
              { onConflict: 'shopify_order_id' }
            );
        } catch (e) {
          log('warn', 'upsert_no_event_failed', { order_id: orderGid, error: (e as Error).message });
        }
        result.orders_no_event_match++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          other_amount: otherAmount,
          event_id: null,
          event_name: null,
          status: 'no_event_match',
        });
        continue;
      }

      // Upsert with event_id — pure attribution write, no ledger or grant changes.
      try {
        const { error } = await supabase
          .from('redemption_orders')
          .upsert(
            {
              customer_id: customerId,
              shopify_order_id: orderGid,
              order_total: orderTotal,
              gift_card_amount: totalGiftCardRedeemed,
              other_amount: otherAmount,
              event_id: eventId,
              raw_transactions: txns as unknown as Record<string, unknown>,
            },
            { onConflict: 'shopify_order_id' }
          );
        if (error) throw new Error(error.message);

        const eventName = await getEventName(eventId);
        result.orders_attributed++;
        result.total_attributed_gift_card += totalGiftCardRedeemed;
        result.total_attributed_revenue += orderTotal;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          other_amount: otherAmount,
          event_id: eventId,
          event_name: eventName,
          status: 'attributed',
        });
      } catch (e) {
        result.orders_errored++;
        result.processed.push({
          order_id: orderGid,
          order_name: order.name,
          email,
          gift_card_amount: totalGiftCardRedeemed,
          order_total: orderTotal,
          other_amount: otherAmount,
          event_id: eventId,
          event_name: null,
          status: 'error',
          detail: (e as Error).message,
        });
      }
    }

    result.total_attributed_gift_card =
      Math.round(result.total_attributed_gift_card * 100) / 100;
    result.total_attributed_revenue =
      Math.round(result.total_attributed_revenue * 100) / 100;
    result.duration_ms = Date.now() - t0;
    log('info', 'completed', {
      duration_ms: result.duration_ms,
      orders_fetched: result.orders_fetched,
      orders_attributed: result.orders_attributed,
      total_attributed_gift_card: result.total_attributed_gift_card,
      total_attributed_revenue: result.total_attributed_revenue,
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
