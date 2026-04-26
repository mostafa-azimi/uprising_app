import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { getGiftCard } from '@/lib/shopify';
import { recomputeBalance } from '@/lib/customers';
import { upsertProfile } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PAGE_SIZE = 50;

interface PageRequest { offset?: number }

interface PageResult {
  scanned: number;
  matched_balances: number;
  drift_corrected: number;
  errors: number;
  next_offset: number | null;
  details: Array<{
    email: string;
    db_balance: number;
    shopify_balance: number;
    delta: number;
    action: 'in_sync' | 'corrected' | 'error';
    error?: string;
  }>;
}

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data: admin } = await supabase
    .from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!admin) throw new Error('Forbidden');
  return user;
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as PageRequest;
  const offset = Math.max(0, body.offset ?? 0);

  const supabase = createSupabaseServiceClient();

  // Pull customers with linked gift cards, ordered by id (stable)
  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id')
    .not('shopify_gift_card_id', 'is', null)
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result: PageResult = {
    scanned: customers?.length ?? 0,
    matched_balances: 0,
    drift_corrected: 0,
    errors: 0,
    next_offset: customers && customers.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
    details: [],
  };

  for (const c of customers ?? []) {
    try {
      const card = await getGiftCard(c.shopify_gift_card_id!);
      if (!card) {
        result.errors++;
        result.details.push({
          email: c.email,
          db_balance: Number(c.total_balance_cached ?? 0),
          shopify_balance: 0,
          delta: 0,
          action: 'error',
          error: 'gift card not found in Shopify',
        });
        continue;
      }
      const shopifyBalance = Number(card.balance.amount);
      const dbBalance = Number(c.total_balance_cached ?? 0);
      const delta = shopifyBalance - dbBalance;

      if (Math.abs(delta) < 0.01) {
        result.matched_balances++;
        result.details.push({
          email: c.email,
          db_balance: dbBalance,
          shopify_balance: shopifyBalance,
          delta: 0,
          action: 'in_sync',
        });
        continue;
      }

      // Drift detected. Shopify is the source of truth — log a reconciliation
      // finding and apply a balancing ledger entry. We DON'T retroactively
      // re-FIFO grants; just record the delta.
      const adjustType = delta > 0 ? 'adjust' : 'redeem'; // negative = customer redeemed, positive = balance higher than expected
      await supabase.from('reconciliation_findings').insert({
        customer_id: c.id,
        computed_balance: dbBalance,
        shopify_balance: shopifyBalance,
        delta,
      });
      await supabase.from('ledger').insert({
        customer_id: c.id,
        grant_id: null,
        type: adjustType,
        amount: delta,
        description: `Resync from Shopify (drift correction): db=$${dbBalance.toFixed(2)}, shopify=$${shopifyBalance.toFixed(2)}`,
        created_by_email: 'shopify resync',
      });
      // Update cached balance directly (we don't touch grants — the source of truth is now Shopify)
      await supabase
        .from('customers')
        .update({ total_balance_cached: shopifyBalance })
        .eq('id', c.id);

      // Push corrected balance to Klaviyo
      try {
        await upsertProfile({
          email: c.email,
          first_name: c.first_name ?? undefined,
          last_name: c.last_name ?? undefined,
          properties: {
            loyalty_card_balance: shopifyBalance,
            loyalty_card_code: c.loyalty_card_code ?? undefined,
          },
        });
      } catch {/* non-fatal */}

      result.drift_corrected++;
      result.details.push({
        email: c.email,
        db_balance: dbBalance,
        shopify_balance: shopifyBalance,
        delta,
        action: 'corrected',
      });
    } catch (e) {
      result.errors++;
      result.details.push({
        email: c.email,
        db_balance: Number(c.total_balance_cached ?? 0),
        shopify_balance: 0,
        delta: 0,
        action: 'error',
        error: (e as Error).message,
      });
    }
  }

  return NextResponse.json(result);
}
