import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface MasterRow {
  shopify_gift_card_id?: string;
  code?: string;
  first_name?: string;
  last_name?: string;
  customer_name?: string;
  customer_email?: string;
  order_id?: string;
  initial_value?: string;
  balance?: string;
  created_at?: string;
  expires_on?: string;
  note?: string;
  gift_card_source?: string;
  reason?: string;
  fulfilled_at?: string;
  disabled_at?: string;
  deleted_at?: string;
}

interface ImportSummary {
  rows_parsed: number;
  customers_upserted: number;
  grants_created: number;
  active_grants: number;
  total_active_balance: number;
  rows_skipped_disabled: number;
  rows_skipped_no_email: number;
  duration_ms: number;
}

const BATCH = 500;

function clean(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function parseDecimal(v: string | undefined | null): number {
  const n = Number((v ?? '').toString().trim());
  return Number.isFinite(n) ? n : 0;
}

/** parse 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD' to a Date */
function parseCreatedAt(s: string | undefined): Date | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  // Add Z to treat as UTC if no tz; otherwise let Date parse it
  const asIso = t.includes('T') ? t : t.replace(' ', 'T') + 'Z';
  const d = new Date(asIso);
  return isNaN(d.getTime()) ? null : d;
}

/** Add N months to a Date and return YYYY-MM-DD */
function addMonthsISO(d: Date, months: number): string {
  const dt = new Date(d);
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get('csv') as File | null;
  if (!file) return NextResponse.json({ error: 'No CSV uploaded' }, { status: 400 });

  const csvText = await file.text();
  const parsed = Papa.parse<MasterRow>(csvText.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) {
    return NextResponse.json(
      { error: `CSV parse: ${parsed.errors.slice(0, 3).map((e) => e.message).join('; ')}` },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceClient();

  // All grants in this import expire on the same day: today + 6 months.
  // Clean slate — `created_at` is preserved on the row for history but does
  // not drive expiration retroactively.
  const importExpires = (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 6);
    return d.toISOString().slice(0, 10);
  })();

  // 1. Upsert one "Master Migration" event row to attribute these grants to
  const { data: existingEvent } = await supabase
    .from('events')
    .select('id')
    .eq('name', 'Master Migration')
    .maybeSingle();
  let migrationEventId = existingEvent?.id;
  if (!migrationEventId) {
    const { data: created, error } = await supabase
      .from('events')
      .insert({
        name: 'Master Migration',
        host: 'Migration',
        source_filename: file.name,
        status: 'completed',
        kind: 'system',
        uploaded_by: user.id,
      })
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: `event insert: ${error.message}` }, { status: 500 });
    migrationEventId = created.id;
  }

  // 2. Build customer records (one per unique email; later rows win on names)
  const customerByEmail = new Map<string, {
    email: string; first_name: string | null; last_name: string | null;
    primary_gift_card_id: string | null; primary_loyalty_card_code: string | null;
    primary_last4: string | null; primary_expiration: string | null;
    total_balance: number;
  }>();

  // 3. Build grant records (one per row with positive balance, not disabled)
  interface GrantPayload {
    customer_email: string;
    shopify_gift_card_id: string;
    shopify_gift_card_code: string | null;
    shopify_gift_card_last4: string | null;
    initial_balance: number;
    initial_amount: number;
    remaining_amount: number;
    expires_on: string;
    reason: string | null;
    note: string | null;
    status: 'active' | 'fully_redeemed';
    created_at: string;
  }
  const grantPayloads: GrantPayload[] = [];

  let rowsSkippedDisabled = 0;
  let rowsSkippedNoEmail = 0;

  for (const r of parsed.data) {
    const email = clean(r.customer_email)?.toLowerCase();
    if (!email) { rowsSkippedNoEmail++; continue; }

    const giftCardId = clean(r.shopify_gift_card_id);
    const code = clean(r.code);
    const last4 = code ? code.slice(-4) : null;
    const initialValue = parseDecimal(r.initial_value);
    const balance = parseDecimal(r.balance);
    const createdAtDate = parseCreatedAt(r.created_at);
    const createdAtIso = createdAtDate ? createdAtDate.toISOString() : new Date().toISOString();
    const expires = importExpires;  // uniform: today + 6 months
    const isDisabled = !!clean(r.disabled_at) || !!clean(r.deleted_at);

    // Customer entry — we keep the latest non-disabled card with the largest
    // remaining balance as the "primary" for display.
    let entry = customerByEmail.get(email);
    if (!entry) {
      entry = {
        email,
        first_name: clean(r.first_name),
        last_name: clean(r.last_name),
        primary_gift_card_id: null,
        primary_loyalty_card_code: null,
        primary_last4: null,
        primary_expiration: null,
        total_balance: 0,
      };
      customerByEmail.set(email, entry);
    }
    if (!entry.first_name) entry.first_name = clean(r.first_name);
    if (!entry.last_name) entry.last_name = clean(r.last_name);
    if (balance > 0) entry.total_balance += balance;

    // Pick the highest-balance non-disabled card as the primary for display
    if (!isDisabled && balance > 0 && (entry.primary_gift_card_id == null || balance > 0)) {
      // use whichever non-disabled card has the latest non-zero balance
      if (entry.primary_gift_card_id == null) {
        entry.primary_gift_card_id = giftCardId ? `gid://shopify/GiftCard/${giftCardId}` : null;
        entry.primary_loyalty_card_code = code;
        entry.primary_last4 = last4;
        entry.primary_expiration = expires;
      }
    }

    // Grant payload — only for non-disabled, non-deleted, balance > 0
    if (isDisabled) { rowsSkippedDisabled++; continue; }
    if (balance <= 0) continue;       // fully-redeemed cards: no active grant
    if (!giftCardId) continue;        // no card id = can't track

    grantPayloads.push({
      customer_email: email,
      shopify_gift_card_id: `gid://shopify/GiftCard/${giftCardId}`,
      shopify_gift_card_code: code,
      shopify_gift_card_last4: last4,
      initial_balance: initialValue,
      initial_amount: balance,           // we treat current balance as the active grant amount
      remaining_amount: balance,
      expires_on: expires,
      reason: clean(r.reason) ?? clean(r.gift_card_source),
      note: clean(r.note),
      status: 'active',
      created_at: createdAtIso,
    });
  }

  // 4. Upsert customers in batches
  const customerRows = Array.from(customerByEmail.values()).map((c) => ({
    email: c.email,
    first_name: c.first_name,
    last_name: c.last_name,
    shopify_gift_card_id: c.primary_gift_card_id,
    loyalty_card_code: c.primary_loyalty_card_code,
    shopify_gift_card_last4: c.primary_last4,
    expiration_date: c.primary_expiration,
    total_balance_cached: Math.round(c.total_balance * 100) / 100,
  }));
  let customersUpserted = 0;
  for (let i = 0; i < customerRows.length; i += BATCH) {
    const batch = customerRows.slice(i, i + BATCH);
    const { error } = await supabase.from('customers').upsert(batch, { onConflict: 'email' });
    if (error) {
      return NextResponse.json({ error: `customer upsert ${i / BATCH + 1}: ${error.message}` }, { status: 500 });
    }
    customersUpserted += batch.length;
  }

  // 5. Resolve customer ids for grant inserts
  const allEmails = Array.from(customerByEmail.keys());
  const emailToId = new Map<string, string>();
  for (let i = 0; i < allEmails.length; i += BATCH) {
    const slice = allEmails.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('customers')
      .select('id, email')
      .in('email', slice);
    if (error) return NextResponse.json({ error: `customer lookup: ${error.message}` }, { status: 500 });
    (data ?? []).forEach((c) => emailToId.set(c.email, c.id));
  }

  // 6. Insert grants in batches
  const grantInserts = grantPayloads.map((g) => ({
    customer_id: emailToId.get(g.customer_email)!,
    event_id: migrationEventId,
    shopify_gift_card_id: g.shopify_gift_card_id,
    shopify_gift_card_code: g.shopify_gift_card_code,
    shopify_gift_card_last4: g.shopify_gift_card_last4,
    initial_balance: g.initial_balance,
    initial_amount: g.initial_amount,
    remaining_amount: g.remaining_amount,
    expires_on: g.expires_on,
    reason: g.reason,
    note: g.note,
    status: g.status,
    created_at: g.created_at,
  })).filter((g) => g.customer_id);

  let grantsCreated = 0;
  for (let i = 0; i < grantInserts.length; i += BATCH) {
    const batch = grantInserts.slice(i, i + BATCH);
    const { data, error } = await supabase.from('grants').insert(batch).select('id, customer_id, initial_amount');
    if (error) return NextResponse.json({ error: `grant insert ${i / BATCH + 1}: ${error.message}` }, { status: 500 });
    grantsCreated += data?.length ?? 0;

    // Ledger entries for the audit trail (one per inserted grant)
    if (data && data.length > 0) {
      const ledgerRows = data.map((g) => ({
        customer_id: g.customer_id,
        grant_id: g.id,
        type: 'issue' as const,
        amount: g.initial_amount,
        description: 'Master Rise import',
        created_by_email: user.email ?? 'master import',
      }));
      await supabase.from('ledger').insert(ledgerRows);
    }
  }

  const summary: ImportSummary = {
    rows_parsed: parsed.data.length,
    customers_upserted: customersUpserted,
    grants_created: grantsCreated,
    active_grants: grantsCreated,
    total_active_balance: Math.round(grantInserts.reduce((s, g) => s + g.initial_amount, 0) * 100) / 100,
    rows_skipped_disabled: rowsSkippedDisabled,
    rows_skipped_no_email: rowsSkippedNoEmail,
    duration_ms: Date.now() - t0,
  };

  return NextResponse.json(summary);
}
