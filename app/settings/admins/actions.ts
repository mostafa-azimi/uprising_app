'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data: admin } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!admin) throw new Error('Forbidden — not an admin');
  return user;
}

export async function inviteAdmin(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!email) return { ok: false, message: 'Email required' };

  const service = createSupabaseServiceClient();
  const origin = headers().get('origin') ?? process.env.APP_URL ?? 'http://localhost:3000';

  // 1. Send Supabase invite email (creates user if missing)
  const { data, error } = await service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent('/account?recovery=1')}`,
  });

  let userId: string | null = data?.user?.id ?? null;

  // If the user already exists, inviteUserByEmail returns an error. Fall back to fetching them.
  if (error && /already.*registered|already.*exists/i.test(error.message)) {
    const { data: list } = await service.auth.admin.listUsers();
    const existing = list?.users?.find((u) => (u.email ?? '').toLowerCase() === email);
    if (existing) userId = existing.id;
  } else if (error) {
    return { ok: false, message: `Invite failed: ${error.message}` };
  }

  if (!userId) {
    return { ok: false, message: 'Invite sent but could not resolve user id' };
  }

  // 2. Add to admin_users (idempotent)
  const { error: insErr } = await service
    .from('admin_users')
    .upsert({ user_id: userId, email });
  if (insErr) {
    return { ok: false, message: `User invited but admin grant failed: ${insErr.message}` };
  }

  revalidatePath('/settings/admins');
  return { ok: true, message: `Invited ${email} and granted admin.` };
}

export async function removeAdmin(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const me = await requireAdmin();
  const userId = String(formData.get('userId') ?? '').trim();
  if (!userId) return { ok: false, message: 'userId required' };
  if (userId === me.id) return { ok: false, message: "You can't remove yourself" };

  const service = createSupabaseServiceClient();
  const { error } = await service.from('admin_users').delete().eq('user_id', userId);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/settings/admins');
  return { ok: true, message: 'Admin removed.' };
}
