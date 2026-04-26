import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { upsertProfile } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PAGE_SIZE = 100;

interface PageRequest { offset?: number }

interface PageResult {
  scanned: number;
  pushed: number;
  errors: number;
  next_offset: number | null;
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

  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, expiration_date')
    .not('loyalty_card_code', 'is', null)
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result: PageResult = {
    scanned: customers?.length ?? 0,
    pushed: 0,
    errors: 0,
    next_offset: customers && customers.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  };

  for (const c of customers ?? []) {
    try {
      await upsertProfile({
        email: c.email,
        first_name: c.first_name ?? undefined,
        last_name: c.last_name ?? undefined,
        properties: {
          loyalty_card_code: c.loyalty_card_code ?? undefined,
          loyalty_card_balance: Number(c.total_balance_cached ?? 0),
          expiration_date: c.expiration_date ?? undefined,
        },
      });
      result.pushed++;
    } catch (e) {
      await supabase.from('sync_log').insert({
        target: 'klaviyo',
        operation: 'resync_push',
        entity_id: c.id,
        ok: false,
        error_message: (e as Error).message,
      });
      result.errors++;
    }
  }

  return NextResponse.json(result);
}
