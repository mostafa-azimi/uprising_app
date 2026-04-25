import { NextResponse } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdminUser } from '@/lib/migrate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface MarryUpResult {
  klaviyo_staging_rows: number;
  shopify_staging_enabled: number;
  customers_upserted_from_klaviyo: number;
  customers_linked_to_gift_card: number;
  customers_unlinked: number;
  ambiguous_last4: number;
  details_unlinked: Array<{ email: string; loyalty_card_code: string; last4: string; reason: 'no_match' | 'ambiguous' }>;
}

export async function POST() {
  try {
    await requireAdminUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();

  // ----- 1. Pull staging rows -------------------------------------------
  const { data: klaviyoRows, error: kErr } = await supabase
    .from('klaviyo_profiles_staging')
    .select('email, first_name, last_name, klaviyo_profile_id, loyalty_card_code, loyalty_card_balance, last_reward, expiration_date');
  if (kErr) {
    return NextResponse.json({ error: `klaviyo staging read: ${kErr.message}` }, { status: 500 });
  }
  // Paginate — Supabase/PostgREST default max-rows is 1,000.
  const shopifyRows: Array<{ id: number; last_characters: string | null; current_balance: number | null; enabled: boolean }> = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('shopify_gift_cards_staging')
      .select('id, last_characters, current_balance, enabled')
      .eq('enabled', true)
      .range(from, from + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: `shopify staging read: ${error.message}` }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    shopifyRows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // ----- 2. Build last4 → cards map -------------------------------------
  const byLast4 = new Map<string, Array<{ id: number; current_balance: number }>>();
  for (const c of shopifyRows ?? []) {
    const key = (c.last_characters ?? '').toLowerCase();
    if (!key) continue;
    const list = byLast4.get(key) ?? [];
    list.push({ id: c.id, current_balance: Number(c.current_balance ?? 0) });
    byLast4.set(key, list);
  }

  // ----- 3. Upsert customers from Klaviyo staging -----------------------
  const upsertPayload = (klaviyoRows ?? [])
    .filter((r) => r.email)
    .map((r) => ({
      email: r.email.trim().toLowerCase(),
      first_name: r.first_name,
      last_name: r.last_name,
      klaviyo_profile_id: r.klaviyo_profile_id,
      loyalty_card_code: r.loyalty_card_code,
      expiration_date: r.expiration_date,
      total_balance_cached: Number(r.loyalty_card_balance ?? 0),
    }));

  let customersUpserted = 0;
  const BATCH = 500;
  for (let i = 0; i < upsertPayload.length; i += BATCH) {
    const batch = upsertPayload.slice(i, i + BATCH);
    const { error } = await supabase.from('customers').upsert(batch, { onConflict: 'email' });
    if (error) {
      return NextResponse.json({ error: `customer upsert: ${error.message}`, customersUpserted }, { status: 500 });
    }
    customersUpserted += batch.length;
  }

  // ----- 4. Link gift cards by last 4 -----------------------------------
  // Pull all customers with a code that aren't yet linked (paginated)
  const needsLink: Array<{ id: string; email: string; loyalty_card_code: string | null }> = [];
  let nlFrom = 0;
  while (true) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, email, loyalty_card_code')
      .not('loyalty_card_code', 'is', null)
      .is('shopify_gift_card_id', null)
      .range(nlFrom, nlFrom + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: `unlinked customers fetch: ${error.message}` }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    needsLink.push(...data);
    if (data.length < PAGE) break;
    nlFrom += PAGE;
  }

  const result: MarryUpResult = {
    klaviyo_staging_rows: klaviyoRows?.length ?? 0,
    shopify_staging_enabled: shopifyRows?.length ?? 0,
    customers_upserted_from_klaviyo: customersUpserted,
    customers_linked_to_gift_card: 0,
    customers_unlinked: 0,
    ambiguous_last4: 0,
    details_unlinked: [],
  };

  // Update one-by-one (could batch but simpler this way; ~600 customers max).
  // For ambiguous matches, prefer the highest current_balance card.
  for (const c of needsLink ?? []) {
    const code = (c.loyalty_card_code ?? '').trim();
    const last4 = code.slice(-4).toLowerCase();
    const matches = byLast4.get(last4) ?? [];

    if (matches.length === 0) {
      result.customers_unlinked++;
      result.details_unlinked.push({ email: c.email, loyalty_card_code: code, last4, reason: 'no_match' });
      continue;
    }

    let chosen = matches[0];
    if (matches.length > 1) {
      // Pick highest balance — most likely the active reloadable card
      chosen = matches.reduce((best, m) => (m.current_balance > best.current_balance ? m : best), matches[0]);
      result.ambiguous_last4++;
    }

    const { error: linkErr } = await supabase
      .from('customers')
      .update({
        shopify_gift_card_id: `gid://shopify/GiftCard/${chosen.id}`,
        shopify_gift_card_last4: last4,
      })
      .eq('id', c.id);
    if (linkErr) {
      result.customers_unlinked++;
      result.details_unlinked.push({ email: c.email, loyalty_card_code: code, last4, reason: 'no_match' });
      continue;
    }
    result.customers_linked_to_gift_card++;
  }

  return NextResponse.json(result);
}
