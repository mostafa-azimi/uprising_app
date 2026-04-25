import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getShopInfo } from '@/lib/shopify';
import { getKlaviyoAccount } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';

interface CheckResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export async function GET() {
  // Auth gate
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: admin } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!admin) return NextResponse.json({ error: 'forbidden — not in admin_users' }, { status: 403 });

  // Run all three checks in parallel
  const [supa, shop, klav] = await Promise.allSettled([
    checkSupabase(),
    checkShopify(),
    checkKlaviyo(),
  ]);

  return NextResponse.json({
    supabase: settle(supa),
    shopify: settle(shop),
    klaviyo: settle(klav),
  });
}

function settle(r: PromiseSettledResult<CheckResult>): CheckResult {
  return r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason?.message || r.reason) };
}

async function checkSupabase(): Promise<CheckResult> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from('customers')
    .select('*', { count: 'exact', head: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, detail: `customers table reachable (${count ?? 0} rows)` };
}

async function checkShopify(): Promise<CheckResult> {
  try {
    const info = await getShopInfo();
    return { ok: true, detail: `${info.name} · ${info.currencyCode} · ${info.primaryDomain.url}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function checkKlaviyo(): Promise<CheckResult> {
  try {
    const acc = await getKlaviyoAccount();
    return { ok: true, detail: `Account ${acc.id}${acc.contact_email ? ' · ' + acc.contact_email : ''}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
