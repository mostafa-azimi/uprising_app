import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CopyButton } from '@/components/copy-button';
import { CustomersTable } from './customers-table';
import { getSignedInUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface SearchParams { q?: string; sort?: string; dir?: string; page?: string; size?: string; balance?: string }

const VALID_SIZES = [25, 50, 75, 100, 150, 200] as const;
const ALL_LIMIT = 2000;

const SORT_COLUMNS: Record<string, string> = {
  email: 'email',
  balance: 'total_balance_cached',
  expiration: 'expiration_date',
  activity: 'updated_at',
  added: 'created_at',
};

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const me = await getSignedInUser();
  const isAdmin = me?.role === 'admin';
  const q = (searchParams.q ?? '').trim().toLowerCase();
  const sortKey = searchParams.sort && SORT_COLUMNS[searchParams.sort] ? searchParams.sort : 'activity';
  const dir = searchParams.dir === 'asc' ? 'asc' : 'desc';
  const sizeParam = searchParams.size ?? '100';
  let pageSize: number;
  if (sizeParam === 'all') {
    pageSize = ALL_LIMIT;
  } else {
    const parsed = parseInt(sizeParam, 10);
    pageSize = (VALID_SIZES as readonly number[]).includes(parsed) ? parsed : 100;
  }
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from('customers')
    .select('id, email, first_name, last_name, total_balance_cached, loyalty_card_code, shopify_gift_card_id, shopify_gift_card_last4, klaviyo_profile_id, expiration_date, created_at, updated_at', { count: 'exact' });

  if (q) {
    query = query.ilike('email', `%${q}%`);
  }

  // Balance filter — default is "positive" (with balance). When searching by
  // email, the filter is intentionally bypassed so customers can be found
  // regardless of their balance.
  const balanceFilter = searchParams.balance && ['positive', 'zero', 'all'].includes(searchParams.balance)
    ? searchParams.balance
    : 'positive';
  const filterActive = !q; // search overrides filter
  if (filterActive) {
    if (balanceFilter === 'positive') {
      query = query.gt('total_balance_cached', 0);
    } else if (balanceFilter === 'zero') {
      query = query.lte('total_balance_cached', 0);
    }
  }

  query = query.order(SORT_COLUMNS[sortKey], { ascending: dir === 'asc', nullsFirst: false });

  const { data: customers, error, count } = await query.range(offset, offset + pageSize - 1);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

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
      <div className="flex items-baseline justify-between mb-6 gap-3 flex-wrap">
        <div>
          <p className="text-sm text-muted">
            {totalCount.toLocaleString()} total · showing {totalCount === 0 ? 0 : offset + 1}–{Math.min(offset + pageSize, totalCount)} on page {page} of {totalPages}
          </p>
          {!filterActive && q && balanceFilter !== 'all' && (
            <p className="text-xs text-muted mt-1 italic">Balance filter is bypassed while searching.</p>
          )}
        </div>
        <a
          href={`/api/admin/export/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`}
          className="text-sm border border-line bg-white hover:border-ink rounded-lg px-3 py-1.5"
        >
          Download CSV
        </a>
      </div>

      <form className="flex flex-wrap gap-3 mb-6 items-center">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by email…"
          className="flex-1 min-w-[200px] border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
        />
        <input type="hidden" name="sort" value={sortKey} />
        <input type="hidden" name="dir" value={dir} />
        <select
          name="balance"
          defaultValue={balanceFilter}
          className="border border-line rounded-lg px-3 py-2 text-sm bg-white"
          title="Filter by balance"
        >
          <option value="all">All customers</option>
          <option value="positive">With balance</option>
          <option value="zero">Zero balance only</option>
        </select>
        <select
          name="size"
          defaultValue={sizeParam}
          className="border border-line rounded-lg px-3 py-2 text-sm bg-white"
          title="Customers per page"
        >
          <option value="25">25 / page</option>
          <option value="50">50 / page</option>
          <option value="75">75 / page</option>
          <option value="100">100 / page</option>
          <option value="150">150 / page</option>
          <option value="200">200 / page</option>
          <option value="all">All</option>
        </select>
        <button type="submit" className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium">Apply</button>
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
          balance={balanceFilter}
          size={sizeParam}
          shopAdminBase={`https://admin.shopify.com/store/${(process.env.SHOPIFY_STORE_DOMAIN || '').replace('.myshopify.com', '')}`}
          isAdmin={isAdmin}
        />
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm">
          <PageLink page={page - 1} disabled={page <= 1} q={q} sort={sortKey} dir={dir} size={sizeParam} balance={balanceFilter}>← Previous</PageLink>
          <span className="text-muted">Page {page} of {totalPages}</span>
          <PageLink page={page + 1} disabled={page >= totalPages} q={q} sort={sortKey} dir={dir} size={sizeParam} balance={balanceFilter}>Next →</PageLink>
        </nav>
      )}
    </main>
  );
}

function PageLink({ page, disabled, q, sort, dir, size, balance, children }: {
  page: number; disabled: boolean; q: string; sort: string; dir: string; size: string; balance: string; children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-muted opacity-50 cursor-not-allowed">{children}</span>;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  if (dir) params.set('dir', dir);
  if (size && size !== '100') params.set('size', size);
  if (balance && balance !== 'positive') params.set('balance', balance);
  params.set('page', String(page));
  return (
    <Link href={`/customers?${params.toString()}`} className="text-ink hover:underline font-medium">
      {children}
    </Link>
  );
}
