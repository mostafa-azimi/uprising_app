import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getSignedInUser } from '@/lib/auth';
import { ExpireNowButton } from './expire-now-button';

export const dynamic = 'force-dynamic';

interface MonthBucket {
  key: string;       // 'YYYY-MM'
  label: string;     // 'Apr 2026'
  total: number;
  grantCount: number;
}

function startOfWeek(d: Date): Date {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  const day = dt.getDay(); // 0 = Sun
  dt.setDate(dt.getDate() - day);
  return dt;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function fmtMonthLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export default async function ExpirationsReportPage() {
  const supabase = createSupabaseServerClient();
  const me = await getSignedInUser();
  const isAdmin = me?.role === 'admin';

  const now = new Date();
  const weekStart = startOfWeek(now);
  const eightMonthsEnd = addMonths(startOfMonth(now), 8);

  // 1) How much expired THIS WEEK (sum of negative ledger 'expire' rows)
  const { data: weekExpiredRows } = await supabase
    .from('ledger')
    .select('amount')
    .eq('type', 'expire')
    .gte('created_at', weekStart.toISOString());
  const weekExpiredTotal = (weekExpiredRows ?? []).reduce((s, r) => s + Math.abs(Number(r.amount ?? 0)), 0);

  // 2) Last 4 weeks for context
  const fourWeeksAgo = new Date(weekStart);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const { data: monthExpiredRows } = await supabase
    .from('ledger')
    .select('amount, created_at')
    .eq('type', 'expire')
    .gte('created_at', fourWeeksAgo.toISOString())
    .order('created_at', { ascending: true });

  // Bucket by week
  const weekBuckets: Record<string, number> = {};
  for (let i = 0; i < 4; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - i * 7);
    weekBuckets[d.toISOString().slice(0, 10)] = 0;
  }
  (monthExpiredRows ?? []).forEach((r) => {
    const d = startOfWeek(new Date(r.created_at));
    const key = d.toISOString().slice(0, 10);
    if (key in weekBuckets) weekBuckets[key] += Math.abs(Number(r.amount ?? 0));
  });
  const weeklyHistory = Object.entries(weekBuckets)
    .map(([weekStartIso, total]) => ({ weekStartIso, total }))
    .sort((a, b) => a.weekStartIso.localeCompare(b.weekStartIso));

  // 3) Upcoming expirations grouped by month (next 8 months)
  // Pull ALL active grants with expires_on between now and 8 months out, paginate
  const upcoming: Array<{ remaining_amount: number; expires_on: string }> = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('grants')
      .select('remaining_amount, expires_on')
      .eq('status', 'active')
      .gte('expires_on', now.toISOString().slice(0, 10))
      .lt('expires_on', eightMonthsEnd.toISOString().slice(0, 10))
      .order('expires_on', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data || data.length === 0) break;
    upcoming.push(...data.map((g) => ({
      remaining_amount: Number(g.remaining_amount ?? 0),
      expires_on: g.expires_on,
    })));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Group into monthly buckets for the chart
  const monthlyBuckets: MonthBucket[] = [];
  for (let i = 0; i < 8; i++) {
    const monthStart = addMonths(startOfMonth(now), i);
    const key = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
    monthlyBuckets.push({
      key,
      label: fmtMonthLabel(monthStart),
      total: 0,
      grantCount: 0,
    });
  }
  for (const g of upcoming) {
    const exp = new Date(g.expires_on + 'T00:00:00');
    const key = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}`;
    const bucket = monthlyBuckets.find((b) => b.key === key);
    if (bucket && g.remaining_amount > 0) {
      bucket.total += g.remaining_amount;
      bucket.grantCount += 1;
    }
  }

  const upcomingTotal = monthlyBuckets.reduce((s, b) => s + b.total, 0);
  const maxBucket = Math.max(...monthlyBuckets.map((b) => b.total), 1);

  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Expirations report</h1>
      <p className="text-sm text-muted mb-6">Money already expired and upcoming over the next 8 calendar months.</p>

      {isAdmin && (
        <section className="mb-8 border border-line rounded-xl bg-white p-5">
          <h2 className="font-semibold mb-1">Manual expiration sweep</h2>
          <p className="text-xs text-muted mb-3">
            Daily cron runs at 7:00 UTC (3am ET / 2am EDT). Use this to catch up on demand.
          </p>
          <ExpireNowButton />
        </section>
      )}

      <section className="grid sm:grid-cols-3 gap-3 mb-8">
        <Stat label="Expired this week" value={`$${weekExpiredTotal.toFixed(2)}`} accent={weekExpiredTotal > 0 ? 'warn' : 'neutral'} />
        <Stat label="Total upcoming (next 8 months)" value={`$${upcomingTotal.toFixed(2)}`} />
        <Stat label="Active grants in window" value={String(upcoming.filter((g) => g.remaining_amount > 0).length)} />
      </section>

      <h2 className="text-xl font-semibold mb-3">Weekly expired (last 4 weeks)</h2>
      <div className="border border-line rounded-xl bg-white p-5 mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 font-medium">Week of</th>
              <th className="py-1 font-medium text-right">Expired</th>
            </tr>
          </thead>
          <tbody>
            {weeklyHistory.map((w) => (
              <tr key={w.weekStartIso} className="border-t border-line">
                <td className="py-1.5">{new Date(w.weekStartIso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                <td className="py-1.5 text-right font-mono">${w.total.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="text-xl font-semibold mb-3">Upcoming expirations (next 8 months)</h2>
      <div className="border border-line rounded-xl bg-white p-6">
        {/* SVG bar chart — purely server-rendered */}
        <svg viewBox={`0 0 ${monthlyBuckets.length * 100} 280`} className="w-full h-72" role="img" aria-label="Upcoming expirations by month">
          {monthlyBuckets.map((b, i) => {
            const x = i * 100;
            const barHeight = (b.total / maxBucket) * 220;
            const barY = 240 - barHeight;
            const isPeak = b.total === maxBucket && maxBucket > 0;
            return (
              <g key={b.key}>
                <rect
                  x={x + 15}
                  y={barY}
                  width={70}
                  height={barHeight}
                  fill={isPeak ? '#EF4444' : '#0F172A'}
                  rx={4}
                />
                <text x={x + 50} y={barY - 6} textAnchor="middle" fontSize="11" fill="#475569">
                  ${b.total.toFixed(0)}
                </text>
                <text x={x + 50} y={258} textAnchor="middle" fontSize="11" fill="#475569">
                  {b.label}
                </text>
                <text x={x + 50} y={272} textAnchor="middle" fontSize="9" fill="#94A3B8">
                  {b.grantCount} grant{b.grantCount === 1 ? '' : 's'}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <details className="mt-6">
        <summary className="cursor-pointer text-sm text-muted">Monthly breakdown</summary>
        <div className="mt-3 border border-line rounded-xl bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium">Month</th>
                <th className="py-2 px-4 font-medium">Active grants</th>
                <th className="py-2 px-4 font-medium">Total expiring</th>
                <th className="py-2 px-4 font-medium">Avg per grant</th>
              </tr>
            </thead>
            <tbody>
              {monthlyBuckets.map((b) => (
                <tr key={b.key} className="border-b border-line last:border-0">
                  <td className="py-2 px-4">{b.label}</td>
                  <td className="py-2 px-4">{b.grantCount}</td>
                  <td className="py-2 px-4 font-semibold">${b.total.toFixed(2)}</td>
                  <td className="py-2 px-4 text-muted">{b.grantCount > 0 ? `$${(b.total / b.grantCount).toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'warn' | 'neutral' }) {
  const cls = accent === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-line bg-white';
  return (
    <div className={`p-4 rounded-xl border ${cls}`}>
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
