import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { paginateAllGiftCards } from '@/lib/shopify';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * TEMPORARY TOOL.
 *
 * Phase 1 — Preview.
 * For every customer with `loyalty_card_code` set but `shopify_gift_card_id`
 * NULL, matches their code's last 4 characters against Shopify gift cards.
 * Returns three buckets: unique match, ambiguous (multiple last-4 matches),
 * not found. Read-only — no DB writes, no Shopify writes.
 */

export interface UniqueMatchRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
  shopify_gift_card_id: string;       // gid://shopify/GiftCard/...
  shopify_masked_code: string | null;
  shopify_balance: number;
  shopify_enabled: boolean;
  app_balance: number;                // total active grant balance in our DB for this customer's unlinked grants
  unlinked_grant_ids: string[];
}

export interface AmbiguousRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
  candidate_count: number;
  candidates: Array<{ id: string; balance: number; enabled: boolean; masked_code: string | null }>;
}

export interface NotFoundRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
}

export interface NoCodeRow {
  customer_id: string;
  email: string;
  app_balance: number;
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  shopify_cards_total: number;
  total_unlinked_customers: number;
  unique_matches: UniqueMatchRow[];
  ambiguous: AmbiguousRow[];
  not_found: NotFoundRow[];
  no_code: NoCodeRow[];
  duration_ms: number;
}

const PAGE = 1000;

export async function POST(request: NextRequest) {
  void request;
  const t0 = Date.now();
  try {
    try {
      await requireAdmin();
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 401 });
    }

    // 1. Pull all Shopify gift cards
    const shopifyCards = await paginateAllGiftCards(200);
    // Build last4 → cards map for quick lookup
    const byLast4 = new Map<string, Array<typeof shopifyCards[number]>>();
    for (const c of shopifyCards) {
      const last4 = (c.lastCharacters ?? '').toLowerCase();
      if (!last4) continue;
      const list = byLast4.get(last4) ?? [];
      list.push(c);
      byLast4.set(last4, list);
    }

    const supabase = createSupabaseServiceClient();

    // 2. Find customers with active grants whose grants are unlinked
    interface UnlinkedGrant {
      id: string;
      customer_id: string;
      remaining_amount: number;
    }
    const grants: UnlinkedGrant[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('grants')
        .select('id, customer_id, remaining_amount')
        .eq('status', 'active')
        .is('shopify_gift_card_id', null)
        .range(from, from + PAGE - 1);
      if (error) {
        return NextResponse.json({ error: `grants query: ${error.message}` }, { status: 500 });
      }
      if (!data || data.length === 0) break;
      for (const g of data) {
        grants.push({ id: g.id, customer_id: g.customer_id, remaining_amount: Number(g.remaining_amount) });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (grants.length === 0) {
      return NextResponse.json({
        ok: true,
        generated_at: new Date().toISOString(),
        shopify_cards_total: shopifyCards.length,
        total_unlinked_customers: 0,
        unique_matches: [],
        ambiguous: [],
        not_found: [],
        no_code: [],
        duration_ms: Date.now() - t0,
      } satisfies PreviewResult);
    }

    // Group by customer
    interface Group {
      customer_id: string;
      grant_ids: string[];
      total_balance: number;
    }
    const byCustomer = new Map<string, Group>();
    for (const g of grants) {
      let entry = byCustomer.get(g.customer_id);
      if (!entry) {
        entry = { customer_id: g.customer_id, grant_ids: [], total_balance: 0 };
        byCustomer.set(g.customer_id, entry);
      }
      entry.grant_ids.push(g.id);
      entry.total_balance += g.remaining_amount;
    }

    // 3. Look up customers — need email and loyalty_card_code
    const customerIds = Array.from(byCustomer.keys());
    const customerInfo = new Map<string, { email: string; loyalty_card_code: string | null; shopify_gift_card_id: string | null }>();
    for (let i = 0; i < customerIds.length; i += PAGE) {
      const slice = customerIds.slice(i, i + PAGE);
      const { data, error } = await supabase
        .from('customers')
        .select('id, email, loyalty_card_code, shopify_gift_card_id')
        .in('id', slice);
      if (error) throw new Error(`customers query: ${error.message}`);
      (data ?? []).forEach((c) =>
        customerInfo.set(c.id, {
          email: c.email,
          loyalty_card_code: c.loyalty_card_code,
          shopify_gift_card_id: c.shopify_gift_card_id,
        })
      );
    }

    // 4. Categorize
    const uniqueMatches: UniqueMatchRow[] = [];
    const ambiguous: AmbiguousRow[] = [];
    const notFound: NotFoundRow[] = [];
    const noCode: NoCodeRow[] = [];

    for (const grp of byCustomer.values()) {
      const info = customerInfo.get(grp.customer_id);
      if (!info) continue;
      const balance = Math.round(grp.total_balance * 100) / 100;
      const code = (info.loyalty_card_code ?? '').trim();

      if (!code) {
        noCode.push({
          customer_id: grp.customer_id,
          email: info.email,
          app_balance: balance,
        });
        continue;
      }

      const last4 = code.slice(-4).toLowerCase();
      const candidates = byLast4.get(last4) ?? [];

      if (candidates.length === 0) {
        notFound.push({
          customer_id: grp.customer_id,
          email: info.email,
          loyalty_card_code: code,
          last4,
        });
        continue;
      }

      if (candidates.length > 1) {
        ambiguous.push({
          customer_id: grp.customer_id,
          email: info.email,
          loyalty_card_code: code,
          last4,
          candidate_count: candidates.length,
          candidates: candidates.map((c) => ({
            id: c.id,
            balance: Number(c.balance.amount),
            enabled: !!c.enabled,
            masked_code: c.maskedCode,
          })),
        });
        continue;
      }

      const card = candidates[0];
      uniqueMatches.push({
        customer_id: grp.customer_id,
        email: info.email,
        loyalty_card_code: code,
        last4,
        shopify_gift_card_id: card.id,
        shopify_masked_code: card.maskedCode,
        shopify_balance: Math.round(Number(card.balance.amount) * 100) / 100,
        shopify_enabled: !!card.enabled,
        app_balance: balance,
        unlinked_grant_ids: grp.grant_ids,
      });
    }

    // Sort each bucket — biggest balance first for review priority
    uniqueMatches.sort((a, b) => b.app_balance - a.app_balance);
    ambiguous.sort((a, b) => a.email.localeCompare(b.email));
    notFound.sort((a, b) => a.email.localeCompare(b.email));
    noCode.sort((a, b) => b.app_balance - a.app_balance);

    return NextResponse.json({
      ok: true,
      generated_at: new Date().toISOString(),
      shopify_cards_total: shopifyCards.length,
      total_unlinked_customers: byCustomer.size,
      unique_matches: uniqueMatches,
      ambiguous,
      not_found: notFound,
      no_code: noCode,
      duration_ms: Date.now() - t0,
    } satisfies PreviewResult);
  } catch (e) {
    return NextResponse.json(
      { error: `Server error after ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
