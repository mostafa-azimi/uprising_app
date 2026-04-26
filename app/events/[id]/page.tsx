import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { expirationClass, fmtDate } from '@/lib/dates';

export const dynamic = 'force-dynamic';

function fmtMoney(n: number | string | null | undefined) {
  if (n == null) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    expired: 'bg-slate-100 text-slate-600 border-slate-200',
    fully_redeemed: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  const cls = styles[status] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${cls}`}>{status}</span>;
}

export default async function EventDetail({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();

  const { data: event } = await supabase
    .from('events')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!event) return notFound();

  const { data: grants } = await supabase
    .from('grants')
    .select('id, customer_id, initial_amount, remaining_amount, expires_on, status, created_at')
    .eq('event_id', params.id)
    .order('created_at', { ascending: true });

  // Pull customer info for the grants
  const customerIds = Array.from(new Set((grants ?? []).map((g) => g.customer_id)));
  const customerMap = new Map<string, { email: string; first_name: string | null; last_name: string | null }>();
  if (customerIds.length) {
    const { data: cs } = await supabase
      .from('customers')
      .select('id, email, first_name, last_name')
      .in('id', customerIds);
    (cs ?? []).forEach((c) => customerMap.set(c.id, c));
  }

  // Aggregates
  const totalIssued = (grants ?? []).reduce((s, g) => s + Number(g.initial_amount), 0);
  const totalRemaining = (grants ?? []).reduce((s, g) => s + Number(g.remaining_amount), 0);
  const totalRedeemed = totalIssued - totalRemaining;
  const redeemPct = totalIssued > 0 ? (totalRedeemed / totalIssued) * 100 : 0;
  const activeCount = (grants ?? []).filter((g) => g.status === 'active').length;

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/events" className="text-sm text-muted hover:text-ink">← Events</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">{event.name}</h1>
      <p className="text-sm text-muted mb-8">
        Host: <strong>{event.host ?? '—'}</strong>
        {event.event_date && ` · Event date: ${fmtDate(event.event_date)}`}
        {event.source_filename && ` · From: ${event.source_filename}`}
      </p>

      <section className="grid sm:grid-cols-4 gap-3 mb-8">
        <Stat label="Total grants" value={String(event.total_grants_count ?? 0)} />
        <Stat label="Total issued" value={fmtMoney(totalIssued)} />
        <Stat label="Active grants" value={String(activeCount)} />
        <Stat label="Redeemed" value={`${fmtMoney(totalRedeemed)} (${redeemPct.toFixed(0)}%)`} />
      </section>

      <h2 className="text-xl font-semibold mb-3">Grants ({(grants ?? []).length})</h2>
      {(!grants || grants.length === 0) ? (
        <div className="p-6 text-center text-muted border border-dashed border-line rounded-xl bg-white text-sm">No grants in this event.</div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium">Customer</th>
                <th className="py-2 px-4 font-medium">Amount</th>
                <th className="py-2 px-4 font-medium">Remaining</th>
                <th className="py-2 px-4 font-medium">Expires</th>
                <th className="py-2 px-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const c = customerMap.get(g.customer_id);
                return (
                  <tr key={g.id} className="border-b border-line last:border-0 hover:bg-slate-50">
                    <td className="py-2 px-4">
                      <Link href={`/customers/${g.customer_id}`} className="text-ink hover:underline">
                        {c?.email ?? '(unknown)'}
                      </Link>
                      {c?.first_name && <div className="text-xs text-muted">{[c.first_name, c.last_name].filter(Boolean).join(' ')}</div>}
                    </td>
                    <td className="py-2 px-4 font-semibold">{fmtMoney(g.initial_amount)}</td>
                    <td className="py-2 px-4">{fmtMoney(g.remaining_amount)}</td>
                    <td className={`py-2 px-4 ${expirationClass(g.expires_on)}`}>{fmtDate(g.expires_on)}</td>
                    <td className="py-2 px-4">{statusBadge(g.status)}</td>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4 rounded-xl border border-line bg-white">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
