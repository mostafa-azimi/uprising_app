import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface SearchParams {
  field?: string;
  email?: string;
  from?: string;
  to?: string;
  page?: string;
}

const PAGE_SIZE = 100;

const FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  loyalty_card_code: 'Loyalty card code',
  expiration_date: 'Expiration date (display)',
  profile_update_legacy: 'Pre-split bulk update',
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  });
}

function fieldBadge(field: string) {
  const styles: Record<string, string> = {
    email: 'bg-blue-50 text-blue-700 border-blue-200',
    loyalty_card_code: 'bg-amber-50 text-amber-700 border-amber-200',
    expiration_date: 'bg-violet-50 text-violet-700 border-violet-200',
    profile_update_legacy: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  const cls = styles[field] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full font-medium ${cls}`}>{FIELD_LABELS[field] ?? field}</span>;
}

export default async function ChangeLogPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const field = searchParams.field ?? 'all';
  const emailFilter = (searchParams.email ?? '').trim().toLowerCase();
  const from = searchParams.from ?? '';
  const to = searchParams.to ?? '';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Email filter → customer ids
  let restrictedIds: string[] | null = null;
  if (emailFilter) {
    const { data: matched } = await supabase
      .from('customers').select('id').ilike('email', `%${emailFilter}%`);
    restrictedIds = (matched ?? []).map((c) => c.id);
    if (restrictedIds.length === 0) restrictedIds = ['___no_match___'];
  }

  let q = supabase
    .from('change_log')
    .select('id, customer_id, field, old_value, new_value, created_at, created_by_email', { count: 'exact' });
  if (field !== 'all') q = q.eq('field', field);
  if (from) q = q.gte('created_at', `${from}T00:00:00Z`);
  if (to) q = q.lte('created_at', `${to}T23:59:59Z`);
  if (restrictedIds) q = q.in('customer_id', restrictedIds);

  const { data: rows, error, count } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Customer email lookup for the rows we got
  const customerIds = Array.from(new Set((rows ?? []).map((r) => r.customer_id)));
  const emailById = new Map<string, string>();
  if (customerIds.length) {
    const { data: cs } = await supabase
      .from('customers').select('id, email').in('id', customerIds);
    (cs ?? []).forEach((c) => emailById.set(c.id, c.email));
  }

  return (
    <main className="min-h-screen px-8 py-10 max-w-7xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Change log</h1>
      <p className="text-sm text-muted mb-6">
        Edits to customer profile fields (email, loyalty card code, expiration date display).
        Doesn't include balance changes — those are in the <Link href="/ledger" className="text-ink hover:underline">ledger</Link>.
        {totalCount > 0 && ` ${totalCount.toLocaleString()} entries · showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, totalCount)} on page ${page} of ${totalPages}.`}
      </p>

      <form className="grid sm:grid-cols-5 gap-3 mb-6 items-end">
        <div>
          <label className="text-xs text-muted block mb-1">Field</label>
          <select name="field" defaultValue={field} className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white">
            <option value="all">All fields</option>
            <option value="email">Email</option>
            <option value="loyalty_card_code">Loyalty card code</option>
            <option value="expiration_date">Expiration date</option>
            <option value="profile_update_legacy">Legacy migrations</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted block mb-1">Email contains</label>
          <input name="email" defaultValue={emailFilter} placeholder="e.g. mike.azimi" className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white" />
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
          No change-log entries match.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium whitespace-nowrap">When</th>
                <th className="py-2 px-4 font-medium">Field</th>
                <th className="py-2 px-4 font-medium">Customer</th>
                <th className="py-2 px-4 font-medium">Old → new</th>
                <th className="py-2 px-4 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-slate-50">
                  <td className="py-2 px-4 text-xs text-muted whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                  <td className="py-2 px-4">{fieldBadge(r.field)}</td>
                  <td className="py-2 px-4">
                    <Link href={`/customers/${r.customer_id}`} className="text-ink hover:underline">
                      {emailById.get(r.customer_id) ?? '(unknown)'}
                    </Link>
                  </td>
                  <td className="py-2 px-4 text-xs">
                    <span className="text-muted line-through font-mono break-all">{r.old_value ?? '∅'}</span>
                    <span className="mx-2 text-muted">→</span>
                    <span className="text-ink font-mono break-all">{r.new_value ?? '∅'}</span>
                  </td>
                  <td className="py-2 px-4 text-xs text-muted">{r.created_by_email ?? 'system'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm">
          <PageLink page={page - 1} disabled={page <= 1} field={field} email={emailFilter} from={from} to={to}>← Previous</PageLink>
          <span className="text-muted">Page {page} of {totalPages}</span>
          <PageLink page={page + 1} disabled={page >= totalPages} field={field} email={emailFilter} from={from} to={to}>Next →</PageLink>
        </nav>
      )}
    </main>
  );
}

function PageLink({ page, disabled, field, email, from, to, children }: {
  page: number; disabled: boolean; field: string; email: string; from: string; to: string; children: React.ReactNode;
}) {
  if (disabled) return <span className="text-muted opacity-50 cursor-not-allowed">{children}</span>;
  const params = new URLSearchParams();
  if (field && field !== 'all') params.set('field', field);
  if (email) params.set('email', email);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('page', String(page));
  return (
    <Link href={`/change-log?${params.toString()}`} className="text-ink hover:underline font-medium">
      {children}
    </Link>
  );
}
