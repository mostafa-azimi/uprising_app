import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'body must be { enabled: boolean }' }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from('app_settings')
    .upsert({
      key: 'auto_expire_enabled',
      value: body.enabled,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
      updated_by_email: user.email ?? null,
    }, { onConflict: 'key' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
