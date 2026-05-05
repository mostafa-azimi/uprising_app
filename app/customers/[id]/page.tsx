import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CopyButton } from '@/components/copy-button';
import { CustomerActions } from './customer-actions';
import { expirationClass } from '@/lib/dates';
import { getSignedInUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface Params { id: string }

function fmtMoney(n: number | string | null | undefined) {
  if (n === null || n === undefined) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  });
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

function ledgerTypeBadge(type: string) {
  const styles: Record<string, string> = {
    issue: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    redeem: 'bg-blue-50 text-blue-700 border-blue-200',
    expire: 'bg-amber-50 text-amber-700 border-amber-200',
    adjust: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  const cls = styles[type] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${cls}`}>{type}</span>;
}

export default async function CustomerDetail({ params }: { params: Params }) {
  const supabase = createSupabaseServerClient();
  const me = await getSignedInUser();
  const isAdmin = me?.role === 'admin';

  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (!customer) return notFound();

  const [{ data: grants }, { data: ledger }, { data: changeLog }] = await Promise.all([
    supabase
      .from('grants')
      .select('id, initial_amount, remaining_amount, expires_on, status, reason, note, created_at, expired_at, event_id, events:event_id ( name, host )')
      .eq('customer_id', params.id)
      .order('expires_on', { ascending: true }),
    supabase
      .from('ledger')
      .select('id, type, amount, description, shopify_transaction_id, shopify_order_id, created_at, grant_id')
      .eq('customer_id', params.id)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('change_log')
      .select('id, field, old_value, new_value, created_at, created_by_email')
      .eq('customer_id', params.id)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '—';
  const activeGrants = (grants ?? []).filter((g: { status: string }) => g.status === 'active');
  const expiredGrants = (grants ?? []).filter((g: { status: string }) => g.status === 'expired');
  const usedGrants = (grants ?? []).filter((g: { status: string }) => g.status === 'fully_redeemed');

  // Build grant_id → expires_on lookup so the ledger can show the expiration
  // beneath each grant-linked entry (Rise-style).
  const expiresByGrantId = new Map<string, string>();
  (grants ?? []).forEach((g: { id: string; expires_on: string }) => {
    expiresByGrantId.set(g.id, g.expires_on);
  });

  const shopifyAdminLink = customer.shopify_customer_id
    ? `https://admin.shopify.com/store/${process.env.SHOPIFY_STORE_DOMAIN?.replace('.myshopify.com', '')}/customers/${customer.shopify_customer_id.split('/').pop()}`
    : null;

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/customers" className="text-sm text-muted hover:text-ink">← Customers</Link>

      <header className="mt-2 mb-8 flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold">{fullName}</h1>
          <p className="text-sm text-muted">{customer.email}</p>
        </div>
        <div className="flex gap-3 text-sm">
          {shopifyAdminLink && (
            <a href={shopifyAdminLink} target="_blank" rel="noreferrer" className="text-ink underline">
              View in Shopify ↗
            </a>
          )}
          {customer.klaviyo_profile_id && (
            <a
              href={`https://www.klaviyo.com/profile/${customer.klaviyo_profile_id}`}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline"
            >
              View in Klaviyo ↗
            </a>
          )}
        </div>
      </header>

      <section className="grid sm:grid-cols-3 gap-3 mb-8">
        <Stat label="Balance" value={fmtMoney(customer.total_balance_cached)} />
        <Stat label="Active grants" value={String(activeGrants.length)} />
        <div className="p-4 rounded-xl border border-line bg-white">
          <div className="text-xs text-muted uppercase tracking-wide">Loyalty card code</div>
          {customer.loyalty_card_code ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-base break-all">{customer.loyalty_card_code}</span>
              <CopyButton value={customer.loyalty_card_code} size="md" label="Copy" />
            </div>
          ) : (
            <div className="text-2xl font-bold mt-1">—</div>
          )}
        </div>
      </section>

      {isAdmin && (
        <CustomerActions
          customerId={customer.id}
          email={customer.email}
          currentBalance={Number(customer.total_balance_cached ?? 0)}
          loyaltyCardCode={customer.loyalty_card_code ?? null}
          expirationDate={customer.expiration_date ?? null}
        />
      )}

      {/* Active grants */}
      <h2 className="text-xl font-semibold mb-3">Active grants ({activeGrants.length})</h2>
      <GrantsTable grants={activeGrants as any[]} showRemaining />

      {/* Inactive grants */}
      {(expiredGrants.length > 0 || usedGrants.length > 0) && (
        <details className="mt-8">
          <summary className="cursor-pointer font-semibold mb-3">
            Past grants ({expiredGrants.length + usedGrants.length})
          </summary>
          <div className="mt-3">
            <GrantsTable grants={[...expiredGrants, ...usedGrants] as any[]} />
          </div>
        </details>
      )}

      {/* Ledger — money-impacting events only */}
      <h2 className="text-xl font-semibold mt-12 mb-1">Ledger ({(ledger ?? []).length})</h2>
      <p className="text-sm text-muted mb-3">Balance-impacting events: issues, redemptions, expirations, manual adjustments.</p>
      {(!ledger || ledger.length === 0) ? (
        <div className="p-6 text-center text-muted border border-dashed border-line rounded-xl bg-white text-sm">
          No ledger entries yet.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium">When</th>
                <th className="py-2 px-4 font-medium">Type</th>
                <th className="py-2 px-4 font-medium">Amount</th>
                <th className="py-2 px-4 font-medium">Description</th>
                <th className="py-2 px-4 font-medium">Reference</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => {
                const grantExp = l.grant_id ? expiresByGrantId.get(l.grant_id) : null;
                // Only show "exp" under the amount for credit-issuing entries (positive amounts)
                const showExp = grantExp && Number(l.amount) > 0;
                return (
                  <tr key={l.id} className="border-b border-line last:border-0">
                    <td className="py-2 px-4 text-muted align-top">{fmtDateTime(l.created_at)}</td>
                    <td className="py-2 px-4 align-top">{ledgerTypeBadge(l.type)}</td>
                    <td className={`py-2 px-4 align-top font-semibold ${Number(l.amount) > 0 ? 'text-emerald-700' : 'text-bad'}`}>
                      <div>{Number(l.amount) > 0 ? '+' : ''}{fmtMoney(l.amount)}</div>
                      {showExp && (
                        <div className={`text-xs font-normal mt-0.5 ${expirationClass(grantExp)}`}>
                          exp {fmtDate(grantExp)}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-4 align-top">{l.description ?? '—'}</td>
                    <td className="py-2 px-4 text-xs text-muted font-mono align-top">
                      {l.shopify_order_id ? `order:${l.shopify_order_id.split('/').pop()}` :
                       l.shopify_transaction_id ? `txn:${l.shopify_transaction_id.split('/').pop()}` :
                       '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Compact change history with deeplink to the full page */}
      <div className="mt-12 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">Recent profile changes ({(changeLog ?? []).length})</h2>
        <Link
          href={`/change-log?email=${encodeURIComponent(customer.email)}`}
          className="text-sm text-ink hover:underline"
        >
          View full change log →
        </Link>
      </div>
      <p className="text-sm text-muted mb-3">Edits to email, loyalty card code, expiration date. Doesn't affect balance.</p>
      {(!changeLog || changeLog.length === 0) ? (
        <div className="p-6 text-center text-muted border border-dashed border-line rounded-xl bg-white text-sm">
          No profile changes yet.
        </div>
      ) : (
        <div className="border border-line rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted bg-slate-50 border-b border-line">
                <th className="py-2 px-4 font-medium">When</th>
                <th className="py-2 px-4 font-medium">Field</th>
                <th className="py-2 px-4 font-medium">Old → new</th>
                <th className="py-2 px-4 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {changeLog.slice(0, 10).map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="py-2 px-4 text-xs text-muted whitespace-nowrap">{fmtDateTime(c.created_at)}</td>
                  <td className="py-2 px-4 font-mono text-xs">{c.field}</td>
                  <td className="py-2 px-4 text-xs">
                    <span className="text-muted line-through">{c.old_value ?? '∅'}</span>
                    <span className="mx-1.5">→</span>
                    <span className="text-ink">{c.new_value ?? '∅'}</span>
                  </td>
                  <td className="py-2 px-4 text-xs text-muted">{c.created_by_email ?? 'system'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="p-4 rounded-xl border border-line bg-white">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${mono ? 'font-mono text-base break-all' : ''}`}>{value}</div>
    </div>
  );
}

interface GrantRow {
  id: string;
  initial_amount: number;
  remaining_amount: number;
  expires_on: string;
  status: string;
  reason: string | null;
  note: string | null;
  created_at: string;
  expired_at: string | null;
  events?: { name: string; host: string | null } | null;
}

function GrantsTable({ grants, showRemaining = false }: { grants: GrantRow[]; showRemaining?: boolean }) {
  if (grants.length === 0) {
    return (
      <div className="p-6 text-center text-muted border border-dashed border-line rounded-xl bg-white text-sm">
        None.
      </div>
    );
  }

  return (
    <div className="border border-line rounded-xl bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted bg-slate-50 border-b border-line">
            <th className="py-2 px-4 font-medium">Issued</th>
            <th className="py-2 px-4 font-medium">Amount</th>
            {showRemaining && <th className="py-2 px-4 font-medium">Remaining</th>}
            <th className="py-2 px-4 font-medium">Expires</th>
            <th className="py-2 px-4 font-medium">Status</th>
            <th className="py-2 px-4 font-medium">Campaign</th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id} className="border-b border-line last:border-0">
              <td className="py-2 px-4 text-muted">{fmtDate(g.created_at)}</td>
              <td className="py-2 px-4 font-semibold">{fmtMoney(g.initial_amount)}</td>
              {showRemaining && (
                <td className="py-2 px-4">
                  {fmtMoney(g.remaining_amount)}
                  {Number(g.remaining_amount) < Number(g.initial_amount) && (
                    <span className="text-xs text-muted ml-1">/ {fmtMoney(g.initial_amount)}</span>
                  )}
                </td>
              )}
              <td className={`py-2 px-4 ${expirationClass(g.expires_on)}`}>{fmtDate(g.expires_on)}</td>
              <td className="py-2 px-4">{statusBadge(g.status)}</td>
              <td className="py-2 px-4 text-muted">{g.events?.name ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
