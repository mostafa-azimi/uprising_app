import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { getSignedInUser } from '@/lib/auth';
import { UsersClient } from './users-client';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const me = await getSignedInUser();
  if (!me || me.role !== 'admin') {
    redirect('/dashboard');
  }

  const service = createSupabaseServiceClient();
  // List every auth.user
  const { data: authList } = await service.auth.admin.listUsers({ perPage: 1000 });
  const authUsers = authList?.users ?? [];

  // Pull current roles from admin_users
  const { data: rows } = await service
    .from('admin_users')
    .select('user_id, email, role, created_at');
  const roleByUserId = new Map<string, { role: string; created_at: string }>();
  (rows ?? []).forEach((r) => roleByUserId.set(r.user_id, { role: r.role ?? 'none', created_at: r.created_at }));

  const users = authUsers.map((u) => {
    const meta = roleByUserId.get(u.id);
    return {
      user_id: u.id,
      email: (u.email ?? '').toLowerCase(),
      role: (meta?.role ?? 'none') as 'admin' | 'viewer' | 'none',
      signed_up: u.created_at,
      last_sign_in: u.last_sign_in_at,
      confirmed: !!u.email_confirmed_at,
    };
  }).sort((a, b) => {
    // admins first, then viewers, then none, then alphabetical
    const order = { admin: 0, viewer: 1, none: 2 } as const;
    if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
    return a.email.localeCompare(b.email);
  });

  return (
    <main className="min-h-screen px-8 py-10 max-w-4xl mx-auto">
      <Link href="/settings" className="text-sm text-muted hover:text-ink">← Settings</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Users</h1>
      <p className="text-sm text-muted mb-6">
        Anyone signed up gets <strong>viewer</strong> access by default (read-only). Promote to <strong>admin</strong> to allow uploads, edits, and admin actions. Set to <strong>none</strong> to revoke access entirely. Sign-up is restricted to <code>@dischub.com</code> addresses.
      </p>

      <UsersClient currentUserId={me.id} users={users} />
    </main>
  );
}
