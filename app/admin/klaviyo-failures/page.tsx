import Link from 'next/link';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { RetryButton } from './retry-button';
import { RetryAllButton } from './retry-all-button';

export const dynamic = 'force-dynamic';

interface Failure {
  customer_id: string;
  email: string;
  failed_at: string;
  error_message: string | null;
  reason: string | null;
}

async function loadFailures(): Promise<Failure[]> {
  const supabase = createSupabaseServiceClient();

  // Last 30 days of terminal failures
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: failures } = await supabase
    .from('sync_log')
    .select('entity_id, created_at, error_message, request_body')
    .eq('target', 'klaviyo')
    .eq('operation', 'profile_property_sync_failed_after_retries')
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (!failures || failures.length === 0) return [];

  // Most recent failure per customer
  const latestFailure = new Map<string, typeof failures[number]>();
  for (const f of failures) {
    if (!f.entity_id) continue;
    if (!latestFailure.has(f.entity_id)) latestFailure.set(f.entity_id, f);
  }

  const customerIds = Array.from(latestFailure.keys());
  if (customerIds.length === 0) return [];

  // Filter out resolved (a successful push happened after the failure)
  const { data: successes } = await supabase
    .from('sync_log')
    .select('entity_id, created_at')
    .eq('target', 'klaviyo')
    .eq('operation', 'profile_property_sync')
    .eq('ok', true)
    .in('entity_id', customerIds)
    .gte('created_at', since);

  const latestSuccess = new Map<string, string>();
  (successes ?? []).forEach((s) => {
    if (!s.entity_id) return;
    const cur = latestSuccess.get(s.entity_id);
    if (!cur || s.created_at > cur) latestSuccess.set(s.entity_id, s.created_at);
  });

  const unresolvedIds: string[] = [];
  const failureByCid = new Map<string, typeof failures[number]>();
  for (const [cid, f] of latestFailure) {
    const successTs = latestSuccess.get(cid);
    if (!successTs || successTs < f.created_at) {
      unresolvedIds.push(cid);
      failureByCid.set(cid, f);
    }
  }

  if (unresolvedIds.length === 0) return [];

  // Fetch customer emails
  const emailById = new Map<string, string>();
  const CHUNK = 100;
  for (let i = 0; i < unresolvedIds.length; i += CHUNK) {
    const slice = unresolvedIds.slice(i, i + CHUNK);
    const { data } = await supabase.from('customers').select('id, email').in('id', slice);
    (data ?? []).forEach((c) => emailById.set(c.id, c.email));
  }

  // Build rows, sorted by most recent failure first
  return unresolvedIds.map((cid) => {
    const f = failureByCid.get(cid)!;
    const reqBody = (f.request_body ?? {}) as { reason?: string };
    return {
      customer_id: cid,
      email: emailById.get(cid) ?? '(unknown email)',
      failed_at: f.created_at,
      error_message: f.error_message,
      reason: reqBody.reason ?? null,
    };
  }).sort((a, b) => b.failed_at.localeCompare(a.failed_at));
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default async function KlaviyoFailuresPage() {
  const failures = await loadFailures();

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/tools" className="text-sm text-muted hover:text-ink">← Tools</Link>
      <div className="flex items-start justify-between gap-4 flex-wrap mt-2 mb-2">
        <h1 className="text-3xl font-bold">Klaviyo sync failures</h1>
        <RetryAllButton failureCount={failures.length} />
      </div>
      <p className="text-sm text-muted mb-6">
        Customers where the last 3 attempts to push to Klaviyo all failed.
        DB and Shopify are correct — only Klaviyo is out of date for these customers.
        Click &quot;Retry now&quot; on a row, or hit &quot;Retry all&quot; to mass-retry up to 200 at once.
        Once a successful push happens, the row drops off.
      </p>

      {failures.length === 0 ? (
        <div className="p-6 rounded-xl border border-emerald-200 bg-emerald-50 text-sm">
          <strong className="text-emerald-800">No pending Klaviyo failures.</strong> Everything is in sync.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium">Customer</th>
                <th className="py-2 px-4 font-medium">Failed at</th>
                <th className="py-2 px-4 font-medium">Reason</th>
                <th className="py-2 px-4 font-medium">Last error</th>
                <th className="py-2 px-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.customer_id} className="border-b border-line last:border-0">
                  <td className="py-2 px-4">
                    <Link href={`/customers/${f.customer_id}`} className="text-ink hover:underline text-xs">
                      {f.email}
                    </Link>
                  </td>
                  <td className="py-2 px-4 text-xs text-muted whitespace-nowrap">{fmtDateTime(f.failed_at)}</td>
                  <td className="py-2 px-4 text-xs text-muted">{f.reason ?? '—'}</td>
                  <td className="py-2 px-4 text-xs text-muted truncate max-w-md" title={f.error_message ?? ''}>
                    {f.error_message ?? '—'}
                  </td>
                  <td className="py-2 px-4 text-right">
                    <RetryButton customerId={f.customer_id} email={f.email} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
