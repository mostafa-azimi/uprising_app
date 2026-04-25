import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CopyButton } from '@/components/copy-button';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

interface SearchParams { q?: string; sort?: string; page?: string }

const PAGE_SIZE = 100;

function fmtRelative(iso: string | null | undefined) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const q = (searchParams.q ?? '').trim().toLowerCase();
  const sort = searchParams.sort ?? 'recent_activity';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id, shopify_gift_card_last4, created_at, updated_at', { count: 'exact' });

  if (q) {
    query = query.ilike('email', `%${q}%`);
  }

  const sorts: Record<string, { col: string; ascending: boolean }> = {
    recent_activity: { col: 'updated_at', ascending: false },
    balance_desc: { col: 'total_balance_cached', ascending: false },
    balance_asc: { col: 'total_balance_cached', ascending: true },
    email_asc: { col: 'email', ascending: true },
    email_desc: { col: 'email', ascending: false },
    created_desc: { col: 'created_at', ascending: false },
  };
  const s = sorts[sort] ?? sorts.recent_activity;
  query = query.order(s.col, { ascending: s.ascending });

  const { data: customers, error, count } = await query.range(offset, offset + PAGE_SIZE - 1);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Grant counts in a separate query
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
      <p className="text-sm text-muted mb-6">
        {totalCount} total · showing {offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} on page {page} of {totalPages}
      </p>

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
          <option value="recent_activity">Recently active</option>
          <option value="balance_desc">Balance (high → low)</option>
          <option value="balance_asc">Balance (low → high)</option>
          <option value="email_asc">Email (A → Z)</option>
          <option value="email_desc">Email (Z → A)</option>
          <option value="created_desc">Recently added</option>
        </select>
        <SubmitButton className="px-4 py-2 rounded-lg text-sm font-medium" pendingLabel="Applying…">
          Apply
        </SubmitButton>
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
                <th className="py-2 px-4 font-medium">Last activity</th>
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
                    <td className="py-2 px-4">
                      {c.loyalty_card_code ? (
                        <span className="inline-flex items-center font-mono text-xs text-muted">
                          {c.loyalty_card_code}
                          <CopyButton value={c.loyalty_card_code} />
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="py-2 px-4 text-muted text-xs" title={c.updated_at ?? ''}>
                      {fmtRelative(c.updated_at)}
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

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm">
          <PageLink page={page - 1} disabled={page <= 1} q={q} sort={sort}>← Previous</PageLink>
          <span className="text-muted">Page {page} of {totalPages}</span>
          <PageLink page={page + 1} disabled={page >= totalPages} q={q} sort={sort}>Next →</PageLink>
        </nav>
      )}
    </main>
  );
}

function PageLink({ page, disabled, q, sort, children }: {
  page: number; disabled: boolean; q: string; sort: string; children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-muted opacity-50 cursor-not-allowed">{children}</span>;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  params.set('page', String(page));
  return (
    <Link href={`/customers?${params.toString()}`} className="text-ink hover:underline font-medium">
      {children}
    </Link>
  );
}
