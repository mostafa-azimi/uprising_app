import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CopyButton } from '@/components/copy-button';
import { CustomersTable } from './customers-table';

export const dynamic = 'force-dynamic';

interface SearchParams { q?: string; sort?: string; dir?: string; page?: string }

const PAGE_SIZE = 100;

const SORT_COLUMNS: Record<string, string> = {
  email: 'email',
  balance: 'total_balance_cached',
  expiration: 'expiration_date',
  activity: 'updated_at',
  added: 'created_at',
};

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const q = (searchParams.q ?? '').trim().toLowerCase();
  const sortKey = searchParams.sort && SORT_COLUMNS[searchParams.sort] ? searchParams.sort : 'activity';
  const dir = searchParams.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id, shopify_gift_card_last4, klaviyo_profile_id, expiration_date, created_at, updated_at', { count: 'exact' });

  if (q) {
    query = query.ilike('email', `%${q}%`);
  }

  query = query.order(SORT_COLUMNS[sortKey], { ascending: dir === 'asc', nullsFirst: false });

  const { data: customers, error, count } = await query.range(offset, offset + PAGE_SIZE - 1);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Active grant counts in a separate query
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
        {totalCount.toLocaleString()} total · showing {totalCount === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} on page {page} of {totalPages}
      </p>

      <form className="flex flex-wrap gap-3 mb-6">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by email…"
          className="flex-1 min-w-[200px] border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
        />
        <input type="hidden" name="sort" value={sortKey} />
        <input type="hidden" name="dir" value={dir} />
        <button type="submit" className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium">Search</button>
      </form>

      {error ? (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error.message}</div>
      ) : !customers || customers.length === 0 ? (
        <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl bg-white">
          No customers match.
        </div>
      ) : (
        <CustomersTable
          customers={customers as any[]}
          grantCounts={grantCounts}
          sortKey={sortKey}
          dir={dir}
          q={q}
          shopAdminBase={`https://admin.shopify.com/store/${(process.env.SHOPIFY_STORE_DOMAIN || '').replace('.myshopify.com', '')}`}
        />
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm">
          <PageLink page={page - 1} disabled={page <= 1} q={q} sort={sortKey} dir={dir}>← Previous</PageLink>
          <span className="text-muted">Page {page} of {totalPages}</span>
          <PageLink page={page + 1} disabled={page >= totalPages} q={q} sort={sortKey} dir={dir}>Next →</PageLink>
        </nav>
      )}
    </main>
  );
}

function PageLink({ page, disabled, q, sort, dir, children }: {
  page: number; disabled: boolean; q: string; sort: string; dir: string; children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-muted opacity-50 cursor-not-allowed">{children}</span>;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  if (dir) params.set('dir', dir);
  params.set('page', String(page));
  return (
    <Link href={`/customers?${params.toString()}`} className="text-ink hover:underline font-medium">
      {children}
    </Link>
  );
}
