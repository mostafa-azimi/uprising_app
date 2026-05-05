import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { paginateAllGiftCards } from '@/lib/shopify';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * PHASE 1 — Preview.
 *
 * Pulls every gift card from Shopify, sums each customer's matching grants in
 * our DB, and returns the discrepancies. Read-only — no DB writes.
 *
 * The diff is computed at the (customer, gift_card) level so multiple grants
 * sharing one Shopify card are aggregated. Apply phase will FIFO-debit those
 * grants when DB > Shopify, or LIFO-credit the newest when DB < Shopify.
 */

export interface DiscrepancyRow {
  customer_id: string;
  email: string;
  shopify_gift_card_id: string;
  last4: string | null;
  shopify_balance: number;
  shopify_enabled: boolean;
  db_total_remaining: number;
  diff: number;                         // shopify - db (negative => DB had more)
  affected_grant_ids: string[];
  expires_on_earliest: string | null;
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  shopify_cards_total: number;
  grants_with_card_id: number;
  customers_with_card: number;
  in_sync_count: number;
  discrepancy_count: number;
  total_db_to_subtract: number;          // sum of NEGATIVE diffs (Shopify lower than DB)
  total_db_to_add: number;               // sum of POSITIVE diffs (Shopify higher than DB)
  unmatched_shopify_card_ids_sample: string[];  // Shopify cards not linked to any grant
  duration_ms: number;
  rows: DiscrepancyRow[];
  message?: string;
}

const PAGE = 1000;

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'sync-shopify-balances-preview', level, event, ts: new Date().toISOString(), ...data };
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

    // 1. Pull every gift card from Shopify
    let shopifyCards: Awaited<ReturnType<typeof paginateAllGiftCards>>;
    try {
      shopifyCards = await paginateAllGiftCards(200);
      log('info', 'shopify_pulled', { count: shopifyCards.length });
    } catch (e) {
      log('error', 'shopify_pull_failed', { error: (e as Error).message });
      return NextResponse.json(
        { error: `Failed to pull gift cards from Shopify: ${(e as Error).message}` },
        { status: 502 }
      );
    }

    // Build map: gift_card_id (already in gid:// form) → balance/enabled
    const shopifyByGid = new Map<string, { balance: number; enabled: boolean; last4: string | null }>();
    for (const c of shopifyCards) {
      shopifyByGid.set(c.id, {
        balance: Number(c.balance.amount),
        enabled: !!c.enabled,
        last4: c.lastCharacters,
      });
    }

    const supabase = createSupabaseServiceClient();

    // 2. Pull every active grant with a shopify_gift_card_id, paged
    interface GrantRow {
      id: string;
      customer_id: string;
      shopify_gift_card_id: string;
      remaining_amount: number;
      expires_on: string;
      status: string;
    }
    const allGrants: GrantRow[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('grants')
        .select('id, customer_id, shopify_gift_card_id, remaining_amount, expires_on, status')
        .not('shopify_gift_card_id', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) {
        log('error', 'grants_query_failed', { error: error.message });
        return NextResponse.json({ error: `grants query: ${error.message}` }, { status: 500 });
      }
      if (!data || data.length === 0) break;
      for (const g of data) {
        if (!g.shopify_gift_card_id) continue;
        allGrants.push({
          id: g.id,
          customer_id: g.customer_id,
          shopify_gift_card_id: g.shopify_gift_card_id,
          remaining_amount: Number(g.remaining_amount),
          expires_on: g.expires_on,
          status: g.status,
        });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    log('info', 'grants_pulled', { count: allGrants.length });

    // 3. Group grants by (customer_id, shopify_gift_card_id), summing remaining_amount
    interface GroupKey {
      customer_id: string;
      gid: string;
    }
    interface Group extends GroupKey {
      grants: GrantRow[];
      db_total: number;
      earliest_expires: string | null;
    }
    const groupMap = new Map<string, Group>();
    for (const g of allGrants) {
      const key = `${g.customer_id}|${g.shopify_gift_card_id}`;
      let entry = groupMap.get(key);
      if (!entry) {
        entry = {
          customer_id: g.customer_id,
          gid: g.shopify_gift_card_id,
          grants: [],
          db_total: 0,
          earliest_expires: null,
        };
        groupMap.set(key, entry);
      }
      entry.grants.push(g);
      // Only count active grants in db_total — fully_redeemed/expired don't reflect available balance
      if (g.status === 'active') entry.db_total += g.remaining_amount;
      if (!entry.earliest_expires || g.expires_on < entry.earliest_expires) {
        entry.earliest_expires = g.expires_on;
      }
    }
    log('info', 'groups_built', { count: groupMap.size });

    // 4. Look up emails for affected customers
    const customerIds = Array.from(new Set(Array.from(groupMap.values()).map((g) => g.customer_id)));
    const emailById = new Map<string, string>();
    for (let i = 0; i < customerIds.length; i += PAGE) {
      const slice = customerIds.slice(i, i + PAGE);
      const { data } = await supabase.from('customers').select('id, email').in('id', slice);
      (data ?? []).forEach((c) => emailById.set(c.id, c.email));
    }

    // 5. Compare and build the diff list
    const rows: DiscrepancyRow[] = [];
    let inSync = 0;
    let totalSub = 0;
    let totalAdd = 0;
    const matchedGids = new Set<string>();

    for (const grp of groupMap.values()) {
      const shopify = shopifyByGid.get(grp.gid);
      if (!shopify) continue;       // no matching Shopify card → handled below as "DB has, Shopify doesn't"
      matchedGids.add(grp.gid);

      const diff = shopify.balance - grp.db_total;
      if (Math.abs(diff) < 0.005) {
        inSync++;
        continue;
      }

      const last4 = shopify.last4 ?? grp.gid.slice(-4);
      rows.push({
        customer_id: grp.customer_id,
        email: emailById.get(grp.customer_id) ?? '(unknown)',
        shopify_gift_card_id: grp.gid,
        last4,
        shopify_balance: Math.round(shopify.balance * 100) / 100,
        shopify_enabled: shopify.enabled,
        db_total_remaining: Math.round(grp.db_total * 100) / 100,
        diff: Math.round(diff * 100) / 100,
        affected_grant_ids: grp.grants.filter((g) => g.status === 'active').map((g) => g.id),
        expires_on_earliest: grp.earliest_expires,
      });
      if (diff < 0) totalSub += diff; else totalAdd += diff;
    }

    // Stable sort: largest absolute discrepancies first
    rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // Identify Shopify cards with no matching grant (potentially a linking gap)
    const unmatchedShopify: string[] = [];
    for (const gid of shopifyByGid.keys()) {
      if (!matchedGids.has(gid)) unmatchedShopify.push(gid);
    }

    const result: PreviewResult = {
      ok: true,
      generated_at: new Date().toISOString(),
      shopify_cards_total: shopifyCards.length,
      grants_with_card_id: allGrants.length,
      customers_with_card: customerIds.length,
      in_sync_count: inSync,
      discrepancy_count: rows.length,
      total_db_to_subtract: Math.round(totalSub * 100) / 100,
      total_db_to_add: Math.round(totalAdd * 100) / 100,
      unmatched_shopify_card_ids_sample: unmatchedShopify.slice(0, 100),
      duration_ms: Date.now() - t0,
      rows,
    };
    log('info', 'completed', {
      duration_ms: result.duration_ms,
      discrepancies: rows.length,
      total_sub: result.total_db_to_subtract,
      total_add: result.total_db_to_add,
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
