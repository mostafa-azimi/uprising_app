import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface SearchParams {
  type?: string;     // 'issue' | 'redeem' | 'expire' | 'adjust' | 'all'
  email?: string;
  from?: string;     // YYYY-MM-DD
  to?: string;       // YYYY-MM-DD
  sort?: string;     // 'created_at' | 'amount' | 'type'
  dir?: string;      // 'asc' | 'desc'
  page?: string;
}

const PAGE_SIZE = 100;

const SORT_COLS: Record<string, string> = {
  created_at: 'created_at',
  amount: 'amount',
  type: 'type',
};

const TYPE_LABELS: Record<string, string> = {
  issue: 'Credit issued',
  redeem: 'Redemption (Shopify)',
  expire: 'Expiration',
  adjust: 'Manual adjust',
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtMoney(n: number) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function typeBadge(type: string, amount: number) {
  // 'adjust' splits into +/- visually
  let key = type;
  if (type === 'adjust') key = amount >= 0 ? 'adjust_credit' : 'adjust_debit';
  const styles: Record<string, string> = {
    issue: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    redeem: 'bg-blue-50 text-blue-700 border-blue-200',
    expire: 'bg-amber-50 text-amber-700 border-amber-200',
    adjust_credit: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    adjust_debit: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  const labels: Record<string, string> = {
    issue: 'issue',
    redeem: 'redeem',
    expire: 'expire',
    adjust_credit: 'adjust +',
    adjust_debit: 'adjust −',
  };
  const cls = styles[key] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full font-medium ${cls}`}>{labels[key]}</span>;
}

export default async function LedgerPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const type = searchParams.type ?? 'all';
  const emailFilter = (searchParams.email ?? '').trim().toLowerCase();
  const from = searchParams.from ?? '';
  const to = searchParams.to ?? '';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const sortKey = searchParams.sort && SORT_COLS[searchParams.sort] ? searchParams.sort : 'created_at';
  const dir: 'asc' | 'desc' = searchParams.dir === 'asc' ? 'asc' : 'desc';

  // Resolve email filter into customer_ids first
  let restrictedCustomerIds: string[] | null = null;
  if (emailFilter) {
    const { data: matched } = await supabase
      .from('customers')
      .select('id')
      .ilike('email', `%${emailFilter}%`);
    restrictedCustomerIds = (matched ?? []).map((c) => c.id);
    if (restrictedCustomerIds.length === 0) restrictedCustomerIds = ['___no_match___'];
  }

  let q = supabase
    .from('ledger')
    .select('id, customer_id, grant_id, type, amount, shopify_transaction_id, shopify_order_id, description, created_at, created_by, created_by_email', { count: 'exact' });

  if (type !== 'all') q = q.eq('type', type);
  if (from) q = q.gte('created_at', `${from}T00:00:00Z`);
  if (to) q = q.lte('created_at', `${to}T23:59:59Z`);
  if (restrictedCustomerIds) q = q.in('customer_id', restrictedCustomerIds);

  const { data: rows, error, count } = await q
    .order(SORT_COLS[sortKey], { ascending: dir === 'asc' })
    .range(offset, offset + PAGE_SIZE - 1);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Pull customer info for the rows we got back (one batch query)
  const customerIds = Array.from(new Set((rows ?? []).map((r) => r.customer_id)));
  const customerMap = new Map<string, { email: string; first_name: string | null; last_name: string | null }>();
  if (customerIds.length) {
    const { data: cs } = await supabase
      .from('customers')
      .select('id, email, first_name, last_name')
      .in('id', customerIds);
    (cs ?? []).forEach((c) => customerMap.set(c.id, c));
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-7xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Ledger</h1>
      <div className="flex items-baseline justify-between mb-6 gap-3 flex-wrap">
        <p className="text-sm text-muted">
          Append-only log of every balance change. {totalCount.toLocaleString()} entries
          {totalCount > 0 && ` · showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, totalCount)} on page ${page} of ${totalPages}`}.
        </p>
        <a
          href={`/api/admin/export/ledger?${new URLSearchParams({
            ...(type !== 'all' ? { type } : {}),
            ...(emailFilter ? { email: emailFilter } : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          }).toString()}`}
          className="text-sm border border-line bg-white hover:border-ink rounded-lg px-3 py-1.5"
        >
          Download CSV
        </a>
      </div>

      <form className="grid sm:grid-cols-5 gap-3 mb-6 items-end">
        <div>
          <label className="text-xs text-muted block mb-1">Type</label>
          <select name="type" defaultValue={type} className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white">
            <option value="all">All</option>
            <option value="issue">Credit issued</option>
            <option value="redeem">Redemption (Shopify)</option>
            <option value="expire">Expiration</option>
            <option value="adjust">Manual adjust</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">Email contains</label>
          <input
            name="email"
            defaultValue={emailFilter}
            placeholder="e.g. mike.azimi"
            className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white"
          />
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">From</label>
          <input type="date" name="from" defaultValue={from} className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white" />
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">To</label>
          <input type="date" name="to" defaultValue={to} className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white" />
        </div>
        <button type="submit" className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium">Apply</button>
      </form>

      {error ? (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error.message}</div>
      ) : !rows || rows.length === 0 ? (
        <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl bg-white">
          No ledger entries match.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium whitespace-nowrap">
                  <SortHeader label="When" col="created_at" sortKey={sortKey} dir={dir} type={type} email={emailFilter} from={from} to={to} />
                </th>
                <th className="py-2 px-4 font-medium">
                  <SortHeader label="Type" col="type" sortKey={sortKey} dir={dir} type={type} email={emailFilter} from={from} to={to} />
                </th>
                <th className="py-2 px-4 font-medium">
                  <SortHeader label="Amount" col="amount" sortKey={sortKey} dir={dir} type={type} email={emailFilter} from={from} to={to} />
                </th>
                <th className="py-2 px-4 font-medium">Customer</th>
                <th className="py-2 px-4 font-medium">Description</th>
                <th className="py-2 px-4 font-medium">By</th>
                <th className="py-2 px-4 font-medium">Reference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = customerMap.get(r.customer_id);
                const amt = Number(r.amount);
                return (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-slate-50">
                    <td className="py-2 px-4 text-xs text-muted whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                    <td className="py-2 px-4">{typeBadge(r.type, amt)}</td>
                    <td className={`py-2 px-4 font-semibold whitespace-nowrap ${amt > 0 ? 'text-emerald-700' : amt < 0 ? 'text-bad' : ''}`}>
                      {fmtMoney(amt)}
                    </td>
                    <td className="py-2 px-4">
                      <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline">
                        {c?.email ?? '(unknown)'}
                      </Link>
                      {c?.first_name && (
                        <div className="text-xs text-muted">{[c.first_name, c.last_name].filter(Boolean).join(' ')}</div>
                      )}
                    </td>
                    <td className="py-2 px-4 text-muted">{r.description ?? '—'}</td>
                    <td className="py-2 px-4 text-xs text-muted">
                      {r.created_by_email ?? (r.type === 'redeem' ? 'shopify webhook' : 'system')}
                    </td>
                    <td className="py-2 px-4 text-xs text-muted font-mono">
                      {r.shopify_order_id ? `order:${String(r.shopify_order_id).split('/').pop()}` :
                       r.shopify_transaction_id ? `txn:${String(r.shopify_transaction_id).split('/').pop()}` :
                       r.grant_id ? `grant:${String(r.grant_id).slice(0, 8)}…` : '—'}
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
          <PageLink page={page - 1} disabled={page <= 1} type={type} email={emailFilter} from={from} to={to} sort={sortKey} dir={dir}>← Previous</PageLink>
          <span className="text-muted">Page {page} of {totalPages}</span>
          <PageLink page={page + 1} disabled={page >= totalPages} type={type} email={emailFilter} from={from} to={to} sort={sortKey} dir={dir}>Next →</PageLink>
        </nav>
      )}
    </main>
  );
}

function PageLink({ page, disabled, type, email, from, to, sort, dir, children }: {
  page: number; disabled: boolean; type: string; email: string; from: string; to: string;
  sort?: string; dir?: 'asc' | 'desc'; children: React.ReactNode;
}) {
  if (disabled) return <span className="text-muted opacity-50 cursor-not-allowed">{children}</span>;
  const params = new URLSearchParams();
  if (type && type !== 'all') params.set('type', type);
  if (email) params.set('email', email);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (sort && sort !== 'created_at') params.set('sort', sort);
  if (dir && dir !== 'desc') params.set('dir', dir);
  params.set('page', String(page));
  return (
    <Link href={`/ledger?${params.toString()}`} className="text-ink hover:underline font-medium">
      {children}
    </Link>
  );
}

function SortHeader({ label, col, sortKey, dir, type, email, from, to }: {
  label: string; col: string; sortKey: string; dir: 'asc' | 'desc';
  type: string; email: string; from: string; to: string;
}) {
  const newDir = sortKey === col && dir === 'desc' ? 'asc' : 'desc';
  const params = new URLSearchParams();
  if (type && type !== 'all') params.set('type', type);
  if (email) params.set('email', email);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('sort', col);
  params.set('dir', newDir);
  const indicator = sortKey === col ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
  return (
    <Link href={`/ledger?${params.toString()}`} className="hover:text-ink inline-flex items-center select-none">
      {label}{indicator}
    </Link>
  );
}
