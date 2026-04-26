'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin, type Role } from '@/lib/auth';

export async function setUserRole(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const me = await requireAdmin();
  const userId = String(formData.get('userId') ?? '').trim();
  const role = String(formData.get('role') ?? '').trim() as Role;
  if (!userId) return { ok: false, message: 'userId required' };
  if (!['admin', 'viewer', 'none'].includes(role)) return { ok: false, message: 'invalid role' };
  if (userId === me.id && role !== 'admin') {
    return { ok: false, message: "You can't demote yourself" };
  }

  const service = createSupabaseServiceClient();
  // Get email from auth.users to keep it on admin_users
  const { data: list } = await service.auth.admin.getUserById(userId);
  const email = list?.user?.email?.toLowerCase() ?? '';
  if (!email) return { ok: false, message: 'user not found in auth' };

  const { error } = await service
    .from('admin_users')
    .upsert({ user_id: userId, email, role });
  if (error) return { ok: false, message: error.message };

  revalidatePath('/settings/users');
  return { ok: true, message: `Updated ${email} → ${role}` };
}

export async function inviteUser(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const role = String(formData.get('role') ?? 'viewer').trim() as Role;
  if (!email) return { ok: false, message: 'Email required' };
  if (!['admin', 'viewer', 'none'].includes(role)) return { ok: false, message: 'invalid role' };
  if (!email.endsWith('@dischub.com')) {
    return { ok: false, message: 'Email must be a @dischub.com address.' };
  }

  const service = createSupabaseServiceClient();
  const origin = headers().get('origin') ?? process.env.APP_URL ?? 'http://localhost:3000';

  const { data, error } = await service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent('/account?recovery=1')}`,
  });

  let userId: string | null = data?.user?.id ?? null;
  if (error && /already.*registered|already.*exists/i.test(error.message)) {
    const { data: list } = await service.auth.admin.listUsers();
    const existing = list?.users?.find((u) => (u.email ?? '').toLowerCase() === email);
    if (existing) userId = existing.id;
  } else if (error) {
    return { ok: false, message: `Invite failed: ${error.message}` };
  }
  if (!userId) return { ok: false, message: 'Invite sent but could not resolve user id' };

  const { error: insErr } = await service
    .from('admin_users')
    .upsert({ user_id: userId, email, role });
  if (insErr) return { ok: false, message: `User invited but role grant failed: ${insErr.message}` };

  revalidatePath('/settings/users');
  return { ok: true, message: `Invited ${email} as ${role}.` };
}
