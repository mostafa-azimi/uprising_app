import { NextResponse } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdminUser } from '@/lib/migrate';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdminUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();

  // Count rows in each staging table; any errors mean the table is missing
  // (the user hasn't run 04_setup_staging.sql yet).
  const [shopify, shopifyEnabled, klaviyo, klaviyoWithCode, customers, linked, withCode] = await Promise.all([
    supabase.from('shopify_gift_cards_staging').select('*', { count: 'exact', head: true }),
    supabase.from('shopify_gift_cards_staging').select('*', { count: 'exact', head: true }).eq('enabled', true),
    supabase.from('klaviyo_profiles_staging').select('*', { count: 'exact', head: true }),
    supabase.from('klaviyo_profiles_staging').select('*', { count: 'exact', head: true }).not('loyalty_card_code', 'is', null),
    supabase.from('customers').select('*', { count: 'exact', head: true }),
    supabase.from('customers').select('*', { count: 'exact', head: true }).not('shopify_gift_card_id', 'is', null),
    supabase.from('customers').select('*', { count: 'exact', head: true }).not('loyalty_card_code', 'is', null),
  ]);

  const tablesReady = !shopify.error && !klaviyo.error;

  return NextResponse.json({
    tablesReady,
    setupError: shopify.error?.message ?? klaviyo.error?.message ?? null,
    counts: {
      shopify_staging_total: shopify.count ?? 0,
      shopify_staging_enabled: shopifyEnabled.count ?? 0,
      klaviyo_staging_total: klaviyo.count ?? 0,
      klaviyo_staging_with_code: klaviyoWithCode.count ?? 0,
      customers_total: customers.count ?? 0,
      customers_with_loyalty_code: withCode.count ?? 0,
      customers_linked_to_gift_card: linked.count ?? 0,
    },
  });
}
