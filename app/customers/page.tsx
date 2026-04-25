import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface SearchParams { q?: string; sort?: string }

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const q = (searchParams.q ?? '').trim().toLowerCase();
  const sort = searchParams.sort ?? 'balance_desc';

  // Pull customers with grant aggregates
  let query = supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_store_credit_account_id, created_at');

  if (q) {
    query = query.ilike('email', `%${q}%`);
  }

  // Sort
  const sorts: Record<string, { col: string; ascending: boolean }> = {
    balance_desc: { col: 'total_balance_cached', ascending: false },
    balance_asc: { col: 'total_balance_cached', ascending: true },
    email_asc: { col: 'email', ascending: true },
    email_desc: { col: 'email', ascending: false },
    recent: { col: 'created_at', ascending: false },
  };
  const s = sorts[sort] ?? sorts.balance_desc;
  query = query.order(s.col, { ascending: s.ascending });

  const { data: customers, error } = await query.limit(200);

  // Grant counts in a separate query (Supabase JS doesn't expose joins with counts cleanly)
  const ids = (customers ?? []).map((c) => c.id);
  const grantCounts: Record<string, { active: number; total: number }> = {};
  if (ids.length) {
    const { data: grantRows } = await supabase
      .from('grants')
      .select('customer_id, status')
      .in('customer_id', ids);
    (grantRows ?? []).forEach((g) => {
      const k = g.customer_id;
      if (!grantCounts[k]) grantCounts[k] = { active: 0, total: 0 };
      grantCounts[k].total++;
      if (g.status === 'active') grantCounts[k].active++;
    });
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Customers</h1>
      <p className="text-sm text-muted mb-6">{customers?.length ?? 0} customers loaded.</p>

      <form className="flex flex-wrap gap-3 mb-6">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by email…"
          className="flex-1 min-w-[200px] border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
        />
        <select
          name="sort"
          defaultValue={sort}
          className="border border-line rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="balance_desc">Balance (high → low)</option>
          <option value="balance_asc">Balance (low → high)</option>
          <option value="email_asc">Email (A → Z)</option>
          <option value="email_desc">Email (Z → A)</option>
          <option value="recent">Recently added</option>
        </select>
        <button className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium">Apply</button>
      </form>

      {error ? (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error.message}</div>
      ) : !customers || customers.length === 0 ? (
        <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl bg-white">
          No customers yet. Upload your first event credits to populate this list.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium">Customer</th>
                <th className="py-2 px-4 font-medium">Balance</th>
                <th className="py-2 px-4 font-medium">Active grants</th>
                <th className="py-2 px-4 font-medium">Loyalty code</th>
                <th className="py-2 px-4 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => {
                const gc = grantCounts[c.id] ?? { active: 0, total: 0 };
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-slate-50">
                    <td className="py-2 px-4">
                      <div className="font-medium">{c.email}</div>
                      <div className="text-xs text-muted">
                        {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                      </div>
                    </td>
                    <td className="py-2 px-4 font-semibold">
                      ${Number(c.total_balance_cached ?? 0).toFixed(2)}
                    </td>
                    <td className="py-2 px-4">
                      {gc.active}{gc.total > gc.active ? <span className="text-muted text-xs"> / {gc.total} total</span> : null}
                    </td>
                    <td className="py-2 px-4 font-mono text-xs text-muted">
                      {c.loyalty_card_code ?? '—'}
                    </td>
                    <td className="py-2 px-4 text-right">
                      <Link href={`/customers/${c.id}`} className="text-ink underline">
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
