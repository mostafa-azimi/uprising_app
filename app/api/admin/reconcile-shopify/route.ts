import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { upsertProfile } from '@/lib/klaviyo';
import { recomputeBalance } from '@/lib/customers';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ShopifyExportRow {
  Id?: string;
  'Last Characters'?: string;
  'Current Balance'?: string;
  'Initial Balance'?: string;
  'Enabled?'?: string;
  'Expired?'?: string;
}

interface ReconcileResult {
  csv_rows: number;
  grants_in_db: number;
  grants_matched: number;
  grants_unchanged: number;
  grants_updated: number;
  grants_zeroed: number;
  customers_resynced: number;
  klaviyo_pushed: number;
  klaviyo_errors: number;
  total_diff_amount: number;
  duration_ms: number;
  unmatched_card_ids: string[];   // cards in CSV with no matching grant in our DB
  sample_changes: Array<{
    email: string;
    gift_card_id: string;
    db_remaining: number;
    shopify_balance: number;
    new_status: string;
  }>;
}

const PAGE = 1000;

function parseDecimal(v: string | undefined): number {
  const n = Number((v ?? '').toString().trim());
  return Number.isFinite(n) ? n : 0;
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get('csv') as File | null;
  if (!file) return NextResponse.json({ error: 'No CSV uploaded' }, { status: 400 });

  const csvText = await file.text();
  const parsed = Papa.parse<ShopifyExportRow>(csvText.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) {
    return NextResponse.json(
      { error: `CSV parse: ${parsed.errors.slice(0, 3).map((e) => e.message).join('; ')}` },
      { status: 400 }
    );
  }

  // Build map: Shopify GID → current balance
  const shopifyByGid = new Map<string, { balance: number; enabled: boolean; last4: string }>();
  for (const r of parsed.data) {
    const id = (r.Id ?? '').trim();
    if (!id) continue;
    const balance = parseDecimal(r['Current Balance']);
    const enabled = (r['Enabled?'] ?? '').trim().toLowerCase() === 'true';
    const last4 = (r['Last Characters'] ?? '').trim().toLowerCase();
    shopifyByGid.set(`gid://shopify/GiftCard/${id}`, { balance, enabled, last4 });
  }

  const supabase = createSupabaseServiceClient();

  // Pull all grants that have a shopify_gift_card_id, in pages
  const allGrants: Array<{
    id: string; customer_id: string; shopify_gift_card_id: string | null;
    remaining_amount: number; expires_on: string; status: string;
  }> = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('grants')
      .select('id, customer_id, shopify_gift_card_id, remaining_amount, expires_on, status')
      .not('shopify_gift_card_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: `grants query: ${error.message}` }, { status: 500 });
    if (!data || data.length === 0) break;
    for (const g of data) {
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

  // Build customer email lookup for ledger + Klaviyo (only for affected customers)
  const result: ReconcileResult = {
    csv_rows: parsed.data.length,
    grants_in_db: allGrants.length,
    grants_matched: 0,
    grants_unchanged: 0,
    grants_updated: 0,
    grants_zeroed: 0,
    customers_resynced: 0,
    klaviyo_pushed: 0,
    klaviyo_errors: 0,
    total_diff_amount: 0,
    duration_ms: 0,
    unmatched_card_ids: [],
    sample_changes: [],
  };

  // Track which customers need recompute
  const affectedCustomerIds = new Set<string>();
  // Per-grant updates to apply
  interface GrantUpdate {
    id: string;
    customer_id: string;
    new_remaining: number;
    new_status: 'active' | 'fully_redeemed' | 'expired';
    diff: number;            // shopify - db (negative = we had more than Shopify)
    shopify_gift_card_id: string;
  }
  const updates: GrantUpdate[] = [];

  for (const g of allGrants) {
    if (!g.shopify_gift_card_id) continue;
    const shopify = shopifyByGid.get(g.shopify_gift_card_id);
    if (!shopify) continue;
    result.grants_matched++;

    const today = new Date().toISOString().slice(0, 10);
    const isPastDue = g.expires_on < today;

    let newStatus: GrantUpdate['new_status'];
    if (shopify.balance <= 0) {
      newStatus = isPastDue ? 'expired' : 'fully_redeemed';
    } else {
      newStatus = isPastDue ? 'expired' : 'active';
    }

    const diff = shopify.balance - g.remaining_amount;
    if (Math.abs(diff) < 0.005 && newStatus === g.status) {
      result.grants_unchanged++;
      continue;
    }

    updates.push({
      id: g.id,
      customer_id: g.customer_id,
      new_remaining: shopify.balance,
      new_status: newStatus,
      diff,
      shopify_gift_card_id: g.shopify_gift_card_id,
    });
    affectedCustomerIds.add(g.customer_id);
    if (shopify.balance <= 0 && g.remaining_amount > 0) result.grants_zeroed++;
    result.total_diff_amount += diff;
  }

  // Identify unmatched Shopify cards (existed in CSV but no matching grant in our DB)
  const matchedShopifyIds = new Set(updates.map((u) => u.shopify_gift_card_id).concat(
    allGrants.filter((g) => g.shopify_gift_card_id && shopifyByGid.has(g.shopify_gift_card_id))
      .map((g) => g.shopify_gift_card_id!)
  ));
  const unmatched: string[] = [];
  for (const gid of shopifyByGid.keys()) {
    if (!matchedShopifyIds.has(gid)) unmatched.push(gid);
  }
  result.unmatched_card_ids = unmatched.slice(0, 50); // sample

  // Apply updates in chunks
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    // Update grants — Postgres doesn't support bulk update with different values
    // per row easily through Supabase JS; do them one-by-one within the chunk.
    await Promise.all(chunk.map((u) =>
      supabase.from('grants').update({
        remaining_amount: u.new_remaining,
        status: u.new_status,
        ...(u.new_status === 'expired' || u.new_status === 'fully_redeemed' ? { expired_at: new Date().toISOString() } : {}),
      }).eq('id', u.id)
    ));

    // Ledger entries (one per drift correction)
    const ledger = chunk.map((u) => ({
      customer_id: u.customer_id,
      grant_id: u.id,
      type: 'adjust' as const,
      amount: u.diff,                    // negative if Shopify is lower than our DB
      description: `Reconcile from Shopify CSV — set to $${u.new_remaining.toFixed(2)} (was $${(u.new_remaining - u.diff).toFixed(2)})`,
      created_by: user.id,
      created_by_email: user.email ?? 'shopify reconcile',
    }));
    if (ledger.length > 0) {
      await supabase.from('ledger').insert(ledger);
    }

    result.grants_updated += chunk.length;
  }

  // Recompute total_balance_cached per affected customer + push Klaviyo
  const affectedIds = Array.from(affectedCustomerIds);
  for (let i = 0; i < affectedIds.length; i += CHUNK) {
    const slice = affectedIds.slice(i, i + CHUNK);
    const { data: customers } = await supabase
      .from('customers')
      .select('id, email, first_name, last_name, loyalty_card_code, total_balance_cached')
      .in('id', slice);

    await Promise.all((customers ?? []).map(async (c) => {
      try {
        const newBalance = await recomputeBalance(c.id);
        result.customers_resynced++;
        // Sample first 20 changes for the response
        if (result.sample_changes.length < 20) {
          // Find the first update for this customer
          const u = updates.find((x) => x.customer_id === c.id);
          if (u) {
            result.sample_changes.push({
              email: c.email,
              gift_card_id: u.shopify_gift_card_id,
              db_remaining: u.new_remaining - u.diff,
              shopify_balance: u.new_remaining,
              new_status: u.new_status,
            });
          }
        }
        try {
          await upsertProfile({
            email: c.email,
            first_name: c.first_name ?? undefined,
            last_name: c.last_name ?? undefined,
            properties: {
              loyalty_card_balance: newBalance,
              loyalty_card_code: c.loyalty_card_code ?? undefined,
            },
          });
          result.klaviyo_pushed++;
        } catch {
          result.klaviyo_errors++;
        }
      } catch {/* skip */}
    }));
  }

  result.total_diff_amount = Math.round(result.total_diff_amount * 100) / 100;
  result.duration_ms = Date.now() - t0;
  return NextResponse.json(result);
}
