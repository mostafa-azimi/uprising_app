import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Check admin gate
  const { data: admin } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user?.id ?? '')
    .maybeSingle();

  const isAdmin = !!admin;

  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <header className="mb-10">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted">Quick links to the most-used pages.</p>
      </header>

      {!isAdmin && (
        <div className="mb-8 p-4 rounded-lg border border-warn bg-yellow-50 text-sm">
          <strong>Admin access not yet granted.</strong> You're signed in but not in the
          <code className="mx-1 px-1 bg-white rounded">admin_users</code> table. Run the SQL
          snippet at the bottom of <code>supabase/migrations/0001_initial_schema.sql</code>
          to grant yourself access, then reload.
        </div>
      )}

      <section className="grid sm:grid-cols-2 gap-4">
        <Link href="/upload/grants" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Upload event credits</h2>
          <p className="text-sm text-muted">Drop a Rise-format CSV. Each row issues a grant, updates Shopify, and syncs Klaviyo properties.</p>
        </Link>
        <Link href="/customers" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Customers</h2>
          <p className="text-sm text-muted">Search by email, see balances, drill into grant + ledger history.</p>
        </Link>
        <Link href="/ledger" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Ledger</h2>
          <p className="text-sm text-muted">Balance-impacting events: issues, redemptions, expirations, manual adjustments.</p>
        </Link>
        <Link href="/change-log" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Change log</h2>
          <p className="text-sm text-muted">Profile-field edits: email, loyalty code, expiration date display. Doesn't affect balance.</p>
        </Link>
        <Link href="/events" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Events</h2>
          <p className="text-sm text-muted">Browse every campaign you've uploaded — grant counts, totals, and the customers covered.</p>
        </Link>
        <Link href="/reports/expirations" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Expirations report</h2>
          <p className="text-sm text-muted">$ expired this week + 8-month forecast chart of upcoming expirations.</p>
        </Link>
      </section>

      <section className="mt-4">
        <Link href="/settings" className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
          <h2 className="font-semibold mb-1">Settings</h2>
          <p className="text-sm text-muted">Account, admin users, integrations, migration tool.</p>
        </Link>
      </section>
    </main>
  );
}
