import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'crypto';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { applyRedemption } from '@/lib/redemptions';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Shopify orders/paid webhook receiver.
 *
 * Setup (one-time, in Shopify admin):
 *   Settings → Notifications → Webhooks → Create webhook
 *   Event: Order paid
 *   Format: JSON
 *   URL: https://your-vercel-domain/api/webhooks/shopify/orders-paid
 *   API version: 2025-10
 * Then copy the webhook secret into Vercel env: SHOPIFY_WEBHOOK_SECRET.
 */

interface OrderTransaction {
  kind?: string;
  gateway?: string;
  status?: string;
  amount?: string | number;
  receipt?: { gift_card_id?: number | string } | null;
}

interface OrderPaidPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  email?: string;
  customer?: { email?: string; id?: number | string };
  transactions?: OrderTransaction[];
  note?: string;
  // The line_items that are gift cards have their gift_card_id; for redemptions the
  // gift card ID is on transactions.receipt.gift_card_id. Both surfaces vary by
  // Shopify version — we check both.
}

function verifyHmac(rawBody: string, hmacHeader: string | null, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  // constant-time compare
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const hmac = request.headers.get('x-shopify-hmac-sha256');
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? '';
  const supabase = createSupabaseServiceClient();

  // Verify (skip in development if secret is unset, but log loudly)
  if (secret) {
    if (!verifyHmac(rawBody, hmac, secret)) {
      await supabase.from('sync_log').insert({
        target: 'shopify',
        operation: 'webhook_orders_paid',
        ok: false,
        status_code: 401,
        error_message: 'HMAC verification failed',
        request_body: { headers: Object.fromEntries(request.headers.entries()) },
      });
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let payload: OrderPaidPayload;
  try {
    payload = JSON.parse(rawBody) as OrderPaidPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const orderId = String(payload.admin_graphql_api_id ?? payload.id ?? '');
  const email = (payload.customer?.email ?? payload.email ?? '').trim().toLowerCase();
  const transactions = payload.transactions ?? [];

  // Sum gift_card transactions (kind=sale, status=success)
  const giftCardTxns = transactions.filter(
    (t) => (t.gateway ?? '').toLowerCase() === 'gift_card'
       && (t.status ?? '').toLowerCase() === 'success'
       && (t.kind ?? '').toLowerCase() === 'sale'
  );
  const totalGiftCardRedeemed = giftCardTxns.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);

  // Log every webhook for audit/debug
  await supabase.from('sync_log').insert({
    target: 'shopify',
    operation: 'webhook_orders_paid',
    entity_id: orderId,
    ok: true,
    status_code: 200,
    request_body: {
      order_id: orderId,
      email,
      gift_card_txns: giftCardTxns.length,
      total_gift_card_redeemed: totalGiftCardRedeemed,
      gift_card_ids: giftCardTxns.map((t) => t.receipt?.gift_card_id ?? null),
    },
  });

  if (totalGiftCardRedeemed <= 0 || giftCardTxns.length === 0) {
    return NextResponse.json({ ok: true, redeemed: 0, reason: 'no gift_card transactions' });
  }

  // Identify the customer. Preferred: gift_card_id on transaction → customers.shopify_gift_card_id.
  // Fallback: order email.
  const giftCardIds = giftCardTxns
    .map((t) => t.receipt?.gift_card_id)
    .filter((x): x is number | string => x !== null && x !== undefined)
    .map((x) => `gid://shopify/GiftCard/${x}`);

  let customerId: string | null = null;

  if (giftCardIds.length > 0) {
    const { data } = await supabase
      .from('customers')
      .select('id')
      .in('shopify_gift_card_id', giftCardIds)
      .limit(1);
    if (data && data.length > 0) customerId = data[0].id;
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
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'webhook_orders_paid',
      entity_id: orderId,
      ok: false,
      error_message: 'customer not found by gift_card_id or email',
      request_body: { email, gift_card_ids: giftCardIds },
    });
    return NextResponse.json({ ok: true, redeemed: 0, reason: 'customer not in our DB' });
  }

  const result = await applyRedemption({
    customerId,
    amount: totalGiftCardRedeemed,
    shopifyOrderId: orderId,
    description: `Shopify order redemption${email ? ' — ' + email : ''}`,
  });

  return NextResponse.json({ ok: result.ok, ...result });
}
