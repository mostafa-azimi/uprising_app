import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { findProfileByEmail, upsertProfile } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface UpdateBody {
  email?: string;
  loyalty_card_code?: string;
  expiration_date?: string;        // YYYY-MM-DD or empty to clear
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as UpdateBody;
  const supabase = createSupabaseServiceClient();

  // Pull current state
  const { data: current, error: fetchErr } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, loyalty_card_code, expiration_date, klaviyo_profile_id, total_balance_cached')
    .eq('id', params.id)
    .maybeSingle();
  if (fetchErr || !current) {
    return NextResponse.json({ error: fetchErr?.message ?? 'customer not found' }, { status: 404 });
  }

  // Validate inputs
  const updates: Record<string, unknown> = {};
  let newEmail: string | null = null;
  let newLoyaltyCode: string | null = null;
  let newExpiration: string | null = null;

  if (body.email !== undefined) {
    const e = body.email.trim().toLowerCase();
    if (!e) return NextResponse.json({ error: 'email cannot be empty' }, { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return NextResponse.json({ error: 'invalid email format' }, { status: 400 });
    }
    if (e !== current.email) {
      // Make sure no other customer already uses this email
      const { data: existing } = await supabase
        .from('customers').select('id').eq('email', e).neq('id', current.id).maybeSingle();
      if (existing) {
        return NextResponse.json({ error: `Another customer already uses ${e}` }, { status: 409 });
      }
      updates.email = e;
      newEmail = e;
    }
  }

  if (body.loyalty_card_code !== undefined) {
    const code = body.loyalty_card_code.trim();
    if (code !== (current.loyalty_card_code ?? '')) {
      updates.loyalty_card_code = code || null;
      newLoyaltyCode = code || null;
    }
  }

  if (body.expiration_date !== undefined) {
    const d = body.expiration_date.trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return NextResponse.json({ error: 'expiration_date must be YYYY-MM-DD or empty' }, { status: 400 });
    }
    if ((d || null) !== (current.expiration_date ?? null)) {
      updates.expiration_date = d || null;
      newExpiration = d || null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, message: 'no changes' });
  }

  // Apply DB update
  const { error: updErr } = await supabase
    .from('customers')
    .update(updates)
    .eq('id', current.id);
  if (updErr) return NextResponse.json({ error: `DB update: ${updErr.message}` }, { status: 500 });

  // Audit log to ledger (non-balance change but useful for history)
  await supabase.from('ledger').insert({
    customer_id: current.id,
    grant_id: null,
    type: 'adjust',
    amount: 0,
    description: 'Profile fields updated: ' + Object.keys(updates).join(', '),
    created_by: user.id,
    created_by_email: user.email,
  });

  // Sync to Klaviyo where relevant
  const klaviyoProperties: Record<string, unknown> = {};
  if (newLoyaltyCode !== null) klaviyoProperties.loyalty_card_code = newLoyaltyCode ?? '';
  if (newExpiration !== null) klaviyoProperties.expiration_date = newExpiration ?? '';

  let klaviyoStatus: string | null = null;
  try {
    if (newEmail) {
      // Email change requires PATCH on the Klaviyo profile id (lookup by OLD email first)
      const oldProfile = await findProfileByEmail(current.email);
      if (oldProfile) {
        // Klaviyo email update goes through upsertProfile which PATCHes by id when 409 happens.
        // Since we have the old id we can update via the profile id path — but our upsertProfile uses email-as-create-key.
        // Easiest: re-upsert using the new email; Klaviyo will return 409 if a profile already has it (we'd then need merge).
        await upsertProfile({
          email: newEmail,
          first_name: current.first_name ?? undefined,
          last_name: current.last_name ?? undefined,
          properties: klaviyoProperties,
        });
        klaviyoStatus = 'created/updated by new email (old profile may need manual merge in Klaviyo if duplicate)';
      } else {
        await upsertProfile({
          email: newEmail,
          first_name: current.first_name ?? undefined,
          last_name: current.last_name ?? undefined,
          properties: klaviyoProperties,
        });
        klaviyoStatus = 'created with new email';
      }
    } else if (Object.keys(klaviyoProperties).length > 0) {
      await upsertProfile({
        email: current.email,
        first_name: current.first_name ?? undefined,
        last_name: current.last_name ?? undefined,
        properties: klaviyoProperties,
      });
      klaviyoStatus = 'properties synced';
    }
  } catch (e) {
    klaviyoStatus = `failed: ${(e as Error).message}`;
    await supabase.from('sync_log').insert({
      target: 'klaviyo',
      operation: 'profile_field_update',
      entity_id: current.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

  return NextResponse.json({
    ok: true,
    updates: Object.keys(updates),
    klaviyo: klaviyoStatus,
  });
}
