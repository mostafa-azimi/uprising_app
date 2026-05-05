import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * TEMPORARY TOOL.
 *
 * Phase 2 — Apply.
 * Receives the unique-match rows from preview and writes the Shopify gift card
 * link to:
 *   - customers.shopify_gift_card_id
 *   - customers.shopify_gift_card_last4
 *   - grants.shopify_gift_card_id, shopify_gift_card_code, shopify_gift_card_last4
 *     (only for currently-unlinked active grants for that customer)
 *
 * No Shopify writes. No card creation. No balance changes. Pure metadata link.
 */

interface ApplyRow {
  customer_id: string;
  email: string;
  loyalty_card_code: string;
  last4: string;
  shopify_gift_card_id: string;
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  status: 'linked' | 'already_linked' | 'stale' | 'error';
  grants_linked: number;
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  customers_linked: number;
  customers_already_linked: number;
  rows_stale: number;
  rows_errored: number;
  total_grants_linked: number;
  duration_ms: number;
  outcomes: ApplyOutcome[];
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  let body: { rows?: ApplyRow[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no rows to apply' }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const result: ApplyResult = {
    ok: true,
    generated_at: new Date().toISOString(),
    rows_received: rows.length,
    customers_linked: 0,
    customers_already_linked: 0,
    rows_stale: 0,
    rows_errored: 0,
    total_grants_linked: 0,
    duration_ms: 0,
    outcomes: [],
  };

  for (const row of rows) {
    const outcome: ApplyOutcome = {
      customer_id: row.customer_id,
      email: row.email,
      status: 'linked',
      grants_linked: 0,
    };

    try {
      // Re-fetch customer to confirm still unlinked (drift check)
      const { data: customer, error: cErr } = await supabase
        .from('customers')
        .select('id, loyalty_card_code, shopify_gift_card_id')
        .eq('id', row.customer_id)
        .maybeSingle();
      if (cErr || !customer) throw new Error(cErr?.message ?? 'customer not found');

      // Drift check — code in DB must still match what preview saw
      if ((customer.loyalty_card_code ?? '') !== row.loyalty_card_code) {
        outcome.status = 'stale';
        outcome.detail = `customer.loyalty_card_code is now '${customer.loyalty_card_code ?? '(null)'}', preview saw '${row.loyalty_card_code}'`;
        result.rows_stale++;
        result.outcomes.push(outcome);
        continue;
      }

      // If customer is already linked, idempotent skip
      if (customer.shopify_gift_card_id) {
        if (customer.shopify_gift_card_id === row.shopify_gift_card_id) {
          outcome.status = 'already_linked';
          result.customers_already_linked++;
          // Still try to link any remaining unlinked grants for this customer
          const { data: ug } = await supabase
            .from('grants')
            .select('id')
            .eq('customer_id', row.customer_id)
            .eq('status', 'active')
            .is('shopify_gift_card_id', null);
          if (ug && ug.length > 0) {
            const { error: gUpErr } = await supabase
              .from('grants')
              .update({
                shopify_gift_card_id: row.shopify_gift_card_id,
                shopify_gift_card_code: row.loyalty_card_code,
                shopify_gift_card_last4: row.last4,
              })
              .in('id', ug.map((g) => g.id));
            if (gUpErr) throw new Error(`grants link update: ${gUpErr.message}`);
            outcome.grants_linked = ug.length;
            result.total_grants_linked += ug.length;
          }
          result.outcomes.push(outcome);
          continue;
        } else {
          outcome.status = 'stale';
          outcome.detail = `customer is already linked to a DIFFERENT card (${customer.shopify_gift_card_id})`;
          result.rows_stale++;
          result.outcomes.push(outcome);
          continue;
        }
      }

      // Update customer pointer
      const { error: cUpErr } = await supabase
        .from('customers')
        .update({
          shopify_gift_card_id: row.shopify_gift_card_id,
          shopify_gift_card_last4: row.last4,
        })
        .eq('id', row.customer_id);
      if (cUpErr) throw new Error(`customer update: ${cUpErr.message}`);

      // Link all unlinked active grants for this customer
      const { data: unlinkedGrants, error: ugErr } = await supabase
        .from('grants')
        .select('id')
        .eq('customer_id', row.customer_id)
        .eq('status', 'active')
        .is('shopify_gift_card_id', null);
      if (ugErr) throw new Error(`unlinked grants query: ${ugErr.message}`);

      if (unlinkedGrants && unlinkedGrants.length > 0) {
        const { error: gUpErr } = await supabase
          .from('grants')
          .update({
            shopify_gift_card_id: row.shopify_gift_card_id,
            shopify_gift_card_code: row.loyalty_card_code,
            shopify_gift_card_last4: row.last4,
          })
          .in('id', unlinkedGrants.map((g) => g.id));
        if (gUpErr) throw new Error(`grants link update: ${gUpErr.message}`);
        outcome.grants_linked = unlinkedGrants.length;
        result.total_grants_linked += unlinkedGrants.length;
      }

      outcome.status = 'linked';
      result.customers_linked++;

      // Audit log
      await supabase.from('sync_log').insert({
        target: 'shopify',
        operation: 'link_by_code',
        entity_id: row.customer_id,
        ok: true,
        request_body: {
          email: row.email,
          loyalty_card_code: row.loyalty_card_code,
          shopify_gift_card_id: row.shopify_gift_card_id,
          grants_linked: outcome.grants_linked,
          actor: user.email,
        },
      });
    } catch (e) {
      outcome.status = 'error';
      outcome.detail = (e as Error).message;
      result.rows_errored++;
    }
    result.outcomes.push(outcome);
  }

  result.duration_ms = Date.now() - t0;
  return NextResponse.json(result);
}
