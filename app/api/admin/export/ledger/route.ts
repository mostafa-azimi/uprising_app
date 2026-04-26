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
  const type = url.searchParams.get('type') ?? 'all';
  const emailFilter = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  const supabase = createSupabaseServiceClient();

  // Resolve email filter into customer ids
  let restrictedIds: string[] | null = null;
  if (emailFilter) {
    const { data: matches } = await supabase
      .from('customers').select('id').ilike('email', `%${emailFilter}%`);
    restrictedIds = (matches ?? []).map((c) => c.id);
    if (restrictedIds.length === 0) restrictedIds = ['___no_match___'];
  }

  // Pull all matching ledger rows in pages
  const all: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    let qb = supabase
      .from('ledger')
      .select('id, customer_id, grant_id, type, amount, shopify_transaction_id, shopify_order_id, description, created_at, created_by_email')
      .order('created_at', { ascending: false });
    if (type !== 'all') qb = qb.eq('type', type);
    if (from) qb = qb.gte('created_at', `${from}T00:00:00Z`);
    if (to) qb = qb.lte('created_at', `${to}T23:59:59Z`);
    if (restrictedIds) qb = qb.in('customer_id', restrictedIds);
    const { data, error } = await qb.range(offset, offset + PAGE - 1);
    if (error) return new Response(error.message, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  // Pull customer email mapping for the ledger rows
  const cIds = Array.from(new Set(all.map((r) => r.customer_id as string).filter(Boolean)));
  const emailById = new Map<string, string>();
  if (cIds.length) {
    for (let i = 0; i < cIds.length; i += PAGE) {
      const chunk = cIds.slice(i, i + PAGE);
      const { data } = await supabase.from('customers').select('id, email').in('id', chunk);
      (data ?? []).forEach((c) => emailById.set(c.id, c.email));
    }
  }

  const headers = [
    'created_at', 'type', 'amount', 'customer_email', 'description', 'created_by',
    'shopify_order_id', 'shopify_transaction_id', 'grant_id', 'customer_id',
  ];
  const rows = all.map((r) => [
    r.created_at, r.type, Number(r.amount ?? 0).toFixed(2),
    emailById.get(r.customer_id as string) ?? '',
    r.description,
    r.created_by_email ?? (r.type === 'redeem' ? 'shopify webhook' : 'system'),
    r.shopify_order_id, r.shopify_transaction_id, r.grant_id, r.customer_id,
  ]);

  const csv = toCsv(headers, rows);
  const filename = `uprising_ledger_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, { headers: csvResponseHeaders(filename) });
}
