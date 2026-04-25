import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface LinkResult {
  csv_rows_parsed: number;
  csv_enabled_cards: number;
  customers_with_code_no_id: number;
  linked: number;
  ambiguous: number;            // multiple Shopify cards with same last4
  no_match: number;             // customer code's last4 didn't appear in CSV
  details: Array<{
    email: string;
    loyalty_card_code: string;
    last4: string;
    outcome: 'linked' | 'ambiguous' | 'no_match';
    matched_card_id?: string;
    candidate_count?: number;
  }>;
}

interface ShopifyExportRow {
  Id?: string;
  'Last Characters'?: string;
  'Current Balance'?: string;
  'Enabled?'?: string;
}

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data: admin } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!admin) throw new Error('Forbidden — not an admin');
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  // Read uploaded CSV
  const form = await request.formData();
  const file = form.get('csv') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No CSV uploaded' }, { status: 400 });
  }
  const csvText = await file.text();

  const parsed = Papa.parse<ShopifyExportRow>(csvText.trim(), {
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

  // Build last4 → cards map (only enabled, non-empty)
  type EnabledCard = { id: string; last4: string };
  const byLast4 = new Map<string, EnabledCard[]>();
  let enabledCount = 0;

  for (const row of parsed.data) {
    const enabled = (row['Enabled?'] ?? '').trim().toLowerCase() === 'true';
    if (!enabled) continue;
    const id = (row.Id ?? '').trim();
    const last4 = (row['Last Characters'] ?? '').trim().toLowerCase();
    if (!id || !last4) continue;
    enabledCount++;
    const list = byLast4.get(last4) ?? [];
    list.push({ id, last4 });
    byLast4.set(last4, list);
  }

  const result: LinkResult = {
    csv_rows_parsed: parsed.data.length,
    csv_enabled_cards: enabledCount,
    customers_with_code_no_id: 0,
    linked: 0,
    ambiguous: 0,
    no_match: 0,
    details: [],
  };

  // Find unlinked customers
  const supabase = createSupabaseServiceClient();
  const { data: needsLink, error: cErr } = await supabase
    .from('customers')
    .select('id, email, loyalty_card_code')
    .not('loyalty_card_code', 'is', null)
    .is('shopify_gift_card_id', null);
  if (cErr) {
    return NextResponse.json({ error: `customers query: ${cErr.message}` }, { status: 500 });
  }
  result.customers_with_code_no_id = needsLink?.length ?? 0;

  if (!needsLink) {
    return NextResponse.json(result);
  }

  // Match and link
  for (const c of needsLink) {
    const code = (c.loyalty_card_code ?? '').trim();
    const last4 = code.slice(-4).toLowerCase();
    const matches = byLast4.get(last4) ?? [];

    if (matches.length === 0) {
      result.no_match++;
      result.details.push({ email: c.email, loyalty_card_code: code, last4, outcome: 'no_match' });
      continue;
    }
    if (matches.length > 1) {
      result.ambiguous++;
      result.details.push({
        email: c.email, loyalty_card_code: code, last4,
        outcome: 'ambiguous', candidate_count: matches.length,
      });
      continue;
    }

    const card = matches[0];
    const { error: linkErr } = await supabase
      .from('customers')
      .update({
        shopify_gift_card_id: `gid://shopify/GiftCard/${card.id}`,
        shopify_gift_card_last4: card.last4,
      })
      .eq('id', c.id);

    if (linkErr) {
      result.no_match++;
      result.details.push({ email: c.email, loyalty_card_code: code, last4, outcome: 'no_match' });
      continue;
    }

    result.linked++;
    result.details.push({
      email: c.email, loyalty_card_code: code, last4,
      outcome: 'linked', matched_card_id: card.id,
    });
  }

  return NextResponse.json(result);
}
