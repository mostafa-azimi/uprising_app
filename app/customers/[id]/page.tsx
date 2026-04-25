import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CopyButton } from '@/components/copy-button';
import { CustomerActions } from './customer-actions';

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
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
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

  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (!customer) return notFound();

  const [{ data: grants }, { data: ledger }] = await Promise.all([
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
  ]);

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '—';
  const activeGrants = (grants ?? []).filter((g: { status: string }) => g.status === 'active');
  const expiredGrants = (grants ?? []).filter((g: { status: string }) => g.status === 'expired');
  const usedGrants = (grants ?? []).filter((g: { status: string }) => g.status === 'fully_redeemed');

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

      <CustomerActions
        customerId={customer.id}
        email={customer.email}
        currentBalance={Number(customer.total_balance_cached ?? 0)}
      />

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

      {/* Ledger */}
      <h2 className="text-xl font-semibold mt-12 mb-3">Ledger ({(ledger ?? []).length})</h2>
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
              {ledger.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <td className="py-2 px-4 text-muted">{fmtDateTime(l.created_at)}</td>
                  <td className="py-2 px-4">{ledgerTypeBadge(l.type)}</td>
                  <td className={`py-2 px-4 font-semibold ${Number(l.amount) > 0 ? 'text-emerald-700' : 'text-bad'}`}>
                    {Number(l.amount) > 0 ? '+' : ''}{fmtMoney(l.amount)}
                  </td>
                  <td className="py-2 px-4">{l.description ?? '—'}</td>
                  <td className="py-2 px-4 text-xs text-muted font-mono">
                    {l.shopify_order_id ? `order:${l.shopify_order_id.split('/').pop()}` :
                     l.shopify_transaction_id ? `txn:${l.shopify_transaction_id.split('/').pop()}` :
                     '—'}
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
              <td className="py-2 px-4">{fmtDate(g.expires_on)}</td>
              <td className="py-2 px-4">{statusBadge(g.status)}</td>
              <td className="py-2 px-4 text-muted">{g.events?.name ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
