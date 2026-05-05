import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * PHASE 1 — Preview.
 *
 * Lists every customer whose active grants are missing a Shopify gift card
 * link (typically from skip-Shopify uploads or DB-only backfills). Aggregates
 * grants per customer so the apply phase can either create a single Shopify
 * card per customer or, for $0 balances, simply mark grants fully_redeemed.
 *
 * Read-only — no DB or Shopify writes.
 */

export interface MaterializeRow {
  customer_id: string;
  email: string;
  customer_has_card: boolean;            // does customers.shopify_gift_card_id exist?
  customer_card_id: string | null;
  total_balance: number;
  grant_count: number;
  earliest_expires_on: string | null;
  grant_ids: string[];
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  total_customers: number;
  customers_zero_balance: number;
  customers_positive_balance: number;
  total_to_create_in_shopify: number;
  rows: MaterializeRow[];
}

const PAGE = 1000;

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'materialize-grants-preview', level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

export async function POST(request: NextRequest) {
  void request;
  const t0 = Date.now();
  try {
    try {
      await requireAdmin();
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 401 });
    }

    log('info', 'started');
    const supabase = createSupabaseServiceClient();

    // 1. Pull all active grants where shopify_gift_card_id is null
    interface GrantRow {
      id: string;
      customer_id: string;
      remaining_amount: number;
      expires_on: string;
    }
    const grants: GrantRow[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('grants')
        .select('id, customer_id, remaining_amount, expires_on')
        .is('shopify_gift_card_id', null)
        .eq('status', 'active')
        .range(from, from + PAGE - 1);
      if (error) {
        log('error', 'grants_query_failed', { error: error.message });
        return NextResponse.json({ error: `grants query: ${error.message}` }, { status: 500 });
      }
      if (!data || data.length === 0) break;
      for (const g of data) {
        grants.push({
          id: g.id,
          customer_id: g.customer_id,
          remaining_amount: Number(g.remaining_amount),
          expires_on: g.expires_on,
        });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (grants.length === 0) {
      return NextResponse.json({
        ok: true,
        generated_at: new Date().toISOString(),
        total_customers: 0,
        customers_zero_balance: 0,
        customers_positive_balance: 0,
        total_to_create_in_shopify: 0,
        rows: [],
      } satisfies PreviewResult);
    }

    // 2. Group by customer
    interface Group {
      customer_id: string;
      grant_ids: string[];
      total_balance: number;
      earliest_expires_on: string | null;
    }
    const byCustomer = new Map<string, Group>();
    for (const g of grants) {
      let entry = byCustomer.get(g.customer_id);
      if (!entry) {
        entry = {
          customer_id: g.customer_id,
          grant_ids: [],
          total_balance: 0,
          earliest_expires_on: null,
        };
        byCustomer.set(g.customer_id, entry);
      }
      entry.grant_ids.push(g.id);
      entry.total_balance += g.remaining_amount;
      if (!entry.earliest_expires_on || g.expires_on < entry.earliest_expires_on) {
        entry.earliest_expires_on = g.expires_on;
      }
    }

    // 3. Pull customer info for those IDs
    const customerIds = Array.from(byCustomer.keys());
    const customerInfo = new Map<string, { email: string; shopify_gift_card_id: string | null }>();
    for (let i = 0; i < customerIds.length; i += PAGE) {
      const slice = customerIds.slice(i, i + PAGE);
      const { data, error } = await supabase
        .from('customers')
        .select('id, email, shopify_gift_card_id')
        .in('id', slice);
      if (error) throw new Error(`customers query: ${error.message}`);
      (data ?? []).forEach((c) =>
        customerInfo.set(c.id, { email: c.email, shopify_gift_card_id: c.shopify_gift_card_id ?? null })
      );
    }

    // 4. Build the preview rows
    const rows: MaterializeRow[] = [];
    let zeroBal = 0;
    let positiveBal = 0;
    let toCreateInShopify = 0;

    for (const grp of byCustomer.values()) {
      const info = customerInfo.get(grp.customer_id);
      if (!info) continue;
      const balance = Math.round(grp.total_balance * 100) / 100;
      const customerHasCard = !!info.shopify_gift_card_id;

      if (balance < 0.005) zeroBal++;
      else {
        positiveBal++;
        if (!customerHasCard) toCreateInShopify++;
      }

      rows.push({
        customer_id: grp.customer_id,
        email: info.email,
        customer_has_card: customerHasCard,
        customer_card_id: info.shopify_gift_card_id,
        total_balance: balance,
        grant_count: grp.grant_ids.length,
        earliest_expires_on: grp.earliest_expires_on,
        grant_ids: grp.grant_ids,
      });
    }

    rows.sort((a, b) => b.total_balance - a.total_balance);

    log('info', 'completed', {
      duration_ms: Date.now() - t0,
      total_customers: rows.length,
      to_create_in_shopify: toCreateInShopify,
      zero_balance: zeroBal,
    });

    return NextResponse.json({
      ok: true,
      generated_at: new Date().toISOString(),
      total_customers: rows.length,
      customers_zero_balance: zeroBal,
      customers_positive_balance: positiveBal,
      total_to_create_in_shopify: toCreateInShopify,
      rows,
    } satisfies PreviewResult);
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
