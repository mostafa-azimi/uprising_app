import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface SearchParams { q?: string; sort?: string; dir?: string; page?: string }
const PAGE_SIZE = 50;

const SORT_COLS: Record<string, string> = {
  created_at: 'created_at',
  name: 'name',
  total_grants_count: 'total_grants_count',
  total_grants_amount: 'total_grants_amount',
};

function fmtMoney(n: number | string | null | undefined) {
  if (n == null) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const q = (searchParams.q ?? '').trim();
  const sortKey = searchParams.sort && SORT_COLS[searchParams.sort] ? searchParams.sort : 'created_at';
  const dir: 'asc' | 'desc' = searchParams.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('events')
    .select('id, name, host, event_date, total_grants_count, total_grants_amount, status, source_filename, created_at', { count: 'exact' })
    .eq('kind', 'upload');  // only events from CSV uploads, not Manual Adjustments / Rise Migration
  if (q) query = query.ilike('name', `%${q}%`);
  query = query.order(SORT_COLS[sortKey], { ascending: dir === 'asc' });

  const { data: events, error, count } = await query.range(offset, offset + PAGE_SIZE - 1);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Events</h1>
      <p className="text-sm text-muted mb-6">
        {totalCount.toLocaleString()} total {totalCount > 0 && `· showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, totalCount)} on page ${page} of ${totalPages}`}
      </p>

      <form className="flex flex-wrap gap-3 mb-6">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name…"
          className="flex-1 min-w-[200px] border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
        />
        <input type="hidden" name="sort" value={sortKey} />
        <input type="hidden" name="dir" value={dir} />
        <button type="submit" className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium">Search</button>
      </form>

      {error ? (
        <div className="p-4 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error.message}</div>
      ) : !events || events.length === 0 ? (
        <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl bg-white">
          No events yet. Upload your first event credits CSV to populate this list.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium"><Sort label="Event name" col="name" sortKey={sortKey} dir={dir} q={q} /></th>
                <th className="py-2 px-4 font-medium">Host</th>
                <th className="py-2 px-4 font-medium"><Sort label="Grants" col="total_grants_count" sortKey={sortKey} dir={dir} q={q} /></th>
                <th className="py-2 px-4 font-medium"><Sort label="Total $" col="total_grants_amount" sortKey={sortKey} dir={dir} q={q} /></th>
                <th className="py-2 px-4 font-medium"><Sort label="Uploaded" col="created_at" sortKey={sortKey} dir={dir} q={q} /></th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-slate-50">
                  <td className="py-2 px-4 font-medium">
                    <Link href={`/events/${e.id}`} className="text-ink hover:underline">{e.name}</Link>
                  </td>
                  <td className="py-2 px-4 text-muted">{e.host ?? '—'}</td>
                  <td className="py-2 px-4">{e.total_grants_count ?? 0}</td>
                  <td className="py-2 px-4 font-semibold">{fmtMoney(e.total_grants_amount)}</td>
                  <td className="py-2 px-4 text-xs text-muted">{fmtDateTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

function Sort({ label, col, sortKey, dir, q }: { label: string; col: string; sortKey: string; dir: 'asc' | 'desc'; q: string }) {
  const newDir = sortKey === col && dir === 'desc' ? 'asc' : 'desc';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('sort', col);
  params.set('dir', newDir);
  const indicator = sortKey === col ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
  return <Link href={`/events?${params.toString()}`} className="hover:text-ink select-none">{label}{indicator}</Link>;
}

function PageLink({ page, disabled, q, sort, dir, children }: { page: number; disabled: boolean; q: string; sort: string; dir: string; children: React.ReactNode }) {
  if (disabled) return <span className="text-muted opacity-50 cursor-not-allowed">{children}</span>;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('sort', sort);
  params.set('dir', dir);
  params.set('page', String(page));
  return <Link href={`/events?${params.toString()}`} className="text-ink hover:underline font-medium">{children}</Link>;
}
