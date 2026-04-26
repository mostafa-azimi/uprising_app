import Link from 'next/link';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { SubmitButton } from '@/components/submit-button';
import { AdminsClient } from './admins-client';

export const dynamic = 'force-dynamic';

export default async function AdminsPage() {
  const auth = createSupabaseServerClient();
  const { data: { user: me } } = await auth.auth.getUser();

  // List current admins
  const service = createSupabaseServiceClient();
  const { data: rows } = await service
    .from('admin_users')
    .select('user_id, email, created_at')
    .order('created_at', { ascending: true });

  return (
    <main className="min-h-screen px-8 py-10 max-w-3xl mx-auto">
      <Link href="/settings" className="text-sm text-muted hover:text-ink">← Settings</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Admin users</h1>
      <p className="text-sm text-muted mb-6">
        People who can sign in and use this app. New admins receive a Supabase invite email and land on the account page to set their password.
      </p>

      <AdminsClient
        currentUserId={me?.id ?? ''}
        admins={(rows ?? []).map((r) => ({ user_id: r.user_id, email: r.email, created_at: r.created_at }))}
      />
    </main>
  );
}
