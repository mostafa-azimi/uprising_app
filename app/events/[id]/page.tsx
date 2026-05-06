import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { expirationClass, fmtDate } from '@/lib/dates';
import { CopyButton } from '@/components/copy-button';

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
  const customerMap = new Map<string, { email: string; first_name: string | null; last_name: string | null; loyalty_card_code: string | null }>();
  if (customerIds.length) {
    const { data: cs } = await supabase
      .from('customers')
      .select('id, email, first_name, last_name, loyalty_card_code')
      .in('id', customerIds);
    (cs ?? []).forEach((c) => customerMap.set(c.id, c));
  }

  // Aggregates
  const totalIssued = (grants ?? []).reduce((s, g) => s + Number(g.initial_amount), 0);
  const totalRemaining = (grants ?? []).reduce((s, g) => s + Number(g.remaining_amount), 0);
  const totalRedeemed = totalIssued - totalRemaining;
  const redeemPct = totalIssued > 0 ? (totalRedeemed / totalIssued) * 100 : 0;
  const activeCount = (grants ?? []).filter((g) => g.status === 'active').length;

  // Pull any existing invoices for this event so the user can re-open them.
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, total, status, paid_at')
    .eq('event_id', params.id)
    .order('created_at', { ascending: false });

  // Revenue attribution combines two sources:
  //  (a) redemption_orders rows whose `event_id` is THIS event — populated by
  //      the live orders/paid webhook AND the read-only "Attribute orders to events" tool.
  //  (b) any redemption_orders row reachable via ledger.grant_id → grant.event_id —
  //      a fallback for older rows that pre-date the event_id column.
  // Dedup by shopify_order_id so a row covered by both sources isn't double counted.
  const grantIds = (grants ?? []).map((g) => g.id);
  let totalGcRedeemed = 0;
  let attributedRevenue = 0;
  let attributedOther = 0;
  let distinctOrderCount = 0;

  const byOrderId = new Map<
    string,
    { order_total: number; gift_card_amount: number; other_amount: number }
  >();

  // (a) Direct event-attribution rows
  const { data: directAttribution } = await supabase
    .from('redemption_orders')
    .select('shopify_order_id, order_total, gift_card_amount, other_amount')
    .eq('event_id', params.id);
  (directAttribution ?? []).forEach((o) => {
    if (!o.shopify_order_id) return;
    byOrderId.set(o.shopify_order_id, {
      order_total: Number(o.order_total ?? 0),
      gift_card_amount: Number(o.gift_card_amount ?? 0),
      other_amount: Number(o.other_amount ?? 0),
    });
  });

  // (b) Fallback: orders reachable via ledger
  if (grantIds.length > 0) {
    const { data: redLedger } = await supabase
      .from('ledger')
      .select('shopify_order_id')
      .in('grant_id', grantIds)
      .eq('type', 'redeem');
    const fallbackOrderIds = Array.from(
      new Set((redLedger ?? []).map((r) => r.shopify_order_id).filter((x): x is string => !!x))
    ).filter((id) => !byOrderId.has(id));
    if (fallbackOrderIds.length > 0) {
      const { data: orders } = await supabase
        .from('redemption_orders')
        .select('shopify_order_id, order_total, gift_card_amount, other_amount')
        .in('shopify_order_id', fallbackOrderIds);
      (orders ?? []).forEach((o) => {
        if (!o.shopify_order_id) return;
        byOrderId.set(o.shopify_order_id, {
          order_total: Number(o.order_total ?? 0),
          gift_card_amount: Number(o.gift_card_amount ?? 0),
          other_amount: Number(o.other_amount ?? 0),
        });
      });
    }
  }

  for (const o of byOrderId.values()) {
    attributedRevenue += o.order_total;
    attributedOther += o.other_amount;
    totalGcRedeemed += o.gift_card_amount;
  }
  distinctOrderCount = byOrderId.size;

  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <Link href="/events" className="text-sm text-muted hover:text-ink">← Events</Link>
      <div className="mt-2 mb-1 flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold">{event.name}</h1>
        <Link
          href={`/events/${params.id}/invoice/new`}
          className="shrink-0 px-4 py-2 bg-ink text-white text-sm rounded-lg hover:bg-slate-800 transition"
        >
          Generate invoice
        </Link>
      </div>
      <p className="text-sm text-muted mb-8">
        Host: <strong>{event.host ?? '—'}</strong>
        {event.event_date && ` · Event date: ${fmtDate(event.event_date)}`}
        {event.source_filename && ` · From: ${event.source_filename}`}
      </p>

      {invoices && invoices.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Invoices ({invoices.length})</h2>
          <div className="border border-line rounded-xl bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted bg-slate-50 border-b border-line">
                  <th className="py-2 px-4 font-medium">Number</th>
                  <th className="py-2 px-4 font-medium">Date</th>
                  <th className="py-2 px-4 font-medium">Total</th>
                  <th className="py-2 px-4 font-medium">Status</th>
                  <th className="py-2 px-4 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-line last:border-0 hover:bg-slate-50">
                    <td className="py-2 px-4 font-medium">{inv.invoice_number}</td>
                    <td className="py-2 px-4">{fmtDate(inv.invoice_date)}</td>
                    <td className="py-2 px-4 font-semibold">{fmtMoney(inv.total)}</td>
                    <td className="py-2 px-4">
                      <InvoiceStatus status={inv.status} paidAt={inv.paid_at} />
                    </td>
                    <td className="py-2 px-4 text-right">
                      <Link
                        href={`/events/${params.id}/invoice/${inv.id}`}
                        className="text-xs text-ink hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="grid sm:grid-cols-4 gap-3 mb-8">
        <Stat label="Total grants" value={String(event.total_grants_count ?? 0)} />
        <Stat label="Total issued" value={fmtMoney(totalIssued)} />
        <Stat label="Active grants" value={String(activeCount)} />
        <Stat label="Redeemed" value={`${fmtMoney(totalRedeemed)} (${redeemPct.toFixed(0)}%)`} />
      </section>

      <h2 className="text-xl font-semibold mb-3">Revenue attribution</h2>
      <p className="text-sm text-muted mb-3">
        Customers used credits from this event in <strong>{distinctOrderCount}</strong> Shopify order{distinctOrderCount === 1 ? '' : 's'}.
        Total order revenue is the gross of all those orders (some may include credit from other events too).
      </p>
      <section className="grid sm:grid-cols-4 gap-3 mb-8">
        <Stat label="Orders that used this event" value={String(distinctOrderCount)} />
        <Stat label="Gift card redeemed (from this event)" value={fmtMoney(totalGcRedeemed)} />
        <Stat label="Non-gift-card revenue" value={fmtMoney(attributedOther)} sublabel="cash / credit / ShopPay" />
        <Stat label="Total attributed order $" value={fmtMoney(attributedRevenue)} />
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
                <th className="py-2 px-4 font-medium">Code</th>
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
                    <td className="py-2 px-4">
                      {c?.loyalty_card_code ? (
                        <span className="inline-flex items-center">
                          <code className="text-xs">{c.loyalty_card_code}</code>
                          <CopyButton value={c.loyalty_card_code} />
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
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

function Stat({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="p-4 rounded-xl border border-line bg-white">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sublabel && <div className="text-xs text-muted mt-1">{sublabel}</div>}
    </div>
  );
}

function InvoiceStatus({ status, paidAt }: { status: string; paidAt: string | null }) {
  const styles: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-600 border-slate-200',
    sent: 'bg-blue-50 text-blue-700 border-blue-200',
    paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    void: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  const cls = styles[status] ?? styles.draft;
  return (
    <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${cls}`}>
      {status}
      {status === 'paid' && paidAt ? ` · ${fmtDate(paidAt)}` : ''}
    </span>
  );
}
