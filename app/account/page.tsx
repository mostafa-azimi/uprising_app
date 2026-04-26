import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { setPassword } from './actions';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: { error?: string; ok?: string; recovery?: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen px-8 py-10 max-w-2xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Account</h1>
      <p className="text-sm text-muted mb-8">Signed in as {user?.email}.</p>

      {searchParams.recovery && (
        <div className="mb-6 p-4 rounded-lg border border-warn bg-yellow-50 text-sm">
          <strong>Reset your password.</strong> Enter a new password below to complete the recovery.
        </div>
      )}

      <section className="border border-line rounded-xl bg-white p-6">
        <h2 className="text-lg font-semibold mb-1">Set or change password</h2>
        <p className="text-sm text-muted mb-4">
          After setting a password, you can use it on the login page instead of waiting for a magic link.
        </p>

        <form action={setPassword} className="space-y-3 max-w-sm">
          <label className="block">
            <span className="text-sm font-medium">New password</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Confirm password</span>
            <input
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <SubmitButton className="rounded-lg px-4 py-2 font-medium" pendingLabel="Saving…">
            Save password
          </SubmitButton>
        </form>

        {searchParams.error && (
          <p className="mt-4 text-sm text-bad">{decodeURIComponent(searchParams.error)}</p>
        )}
        {searchParams.ok && (
          <p className="mt-4 text-sm text-ok">{decodeURIComponent(searchParams.ok)}</p>
        )}
      </section>
    </main>
  );
}
