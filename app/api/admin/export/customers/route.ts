import { type NextRequest } from 'next/server';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { toCsv, csvResponseHeaders } from '@/lib/csv-export';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PAGE = 1000;

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data: admin } = await supabase
    .from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!admin) throw new Error('Forbidden');
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return new Response((e as Error).message, { status: 401 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();

  const supabase = createSupabaseServiceClient();

  // Paginate to bypass the 1000-row PostgREST limit
  const all: Array<Record<string, unknown>> = [];
  let from = 0;
  while (true) {
    let qbuilder = supabase
      .from('customers')
      .select('email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id, shopify_gift_card_last4, klaviyo_profile_id, expiration_date, created_at, updated_at')
      .order('email', { ascending: true });
    if (q) qbuilder = qbuilder.ilike('email', `%${q}%`);
    const { data, error } = await qbuilder.range(from, from + PAGE - 1);
    if (error) return new Response(error.message, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const headers = [
    'email', 'first_name', 'last_name',
    'total_balance', 'loyalty_card_code', 'shopify_gift_card_id', 'shopify_gift_card_last4',
    'klaviyo_profile_id', 'expiration_date', 'created_at', 'last_activity_at',
  ];
  const rows = all.map((c) => [
    c.email, c.first_name, c.last_name,
    Number(c.total_balance_cached ?? 0).toFixed(2),
    c.loyalty_card_code, c.shopify_gift_card_id, c.shopify_gift_card_last4,
    c.klaviyo_profile_id, c.expiration_date, c.created_at, c.updated_at,
  ]);

  const csv = toCsv(headers, rows);
  const filename = `uprising_customers_${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, { headers: csvResponseHeaders(filename) });
}
