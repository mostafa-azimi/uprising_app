import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdminUser, parseDecimal, parseBool, parseTimestamp, parseDate, clean } from '@/lib/migrate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ShopifyRow {
  Id?: string;
  'Last Characters'?: string;
  'Customer Name'?: string;
  Email?: string;
  'Date Issued'?: string;
  'Expires On'?: string;
  'Initial Balance'?: string;
  'Current Balance'?: string;
  'Enabled?'?: string;
  'Expired?'?: string;
  Note?: string;
}

const BATCH = 500;

export async function POST(request: NextRequest) {
  try {
    await requireAdminUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get('csv') as File | null;
  if (!file) return NextResponse.json({ error: 'No CSV uploaded' }, { status: 400 });

  const csvText = await file.text();
  const parsed = Papa.parse<ShopifyRow>(csvText.trim(), {
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

  // Map rows → staging schema
  const records = parsed.data
    .filter((r) => r.Id && r.Id.trim())
    .map((r) => ({
      id: Number(String(r.Id).trim()),
      last_characters: clean(r['Last Characters'])?.toLowerCase() ?? null,
      customer_name: clean(r['Customer Name']),
      email: clean(r.Email)?.toLowerCase() ?? null,
      date_issued: parseTimestamp(r['Date Issued']),
      expires_on: parseDate(r['Expires On']),
      initial_balance: parseDecimal(r['Initial Balance']),
      current_balance: parseDecimal(r['Current Balance']),
      enabled: parseBool(r['Enabled?']),
      expired: parseBool(r['Expired?']),
      note: clean(r.Note),
    }))
    .filter((r) => Number.isFinite(r.id));

  const supabase = createSupabaseServiceClient();

  // Wipe staging — full replace each upload (idempotent)
  const { error: delErr } = await supabase.from('shopify_gift_cards_staging').delete().neq('id', -1);
  if (delErr) {
    return NextResponse.json({ error: `staging clear: ${delErr.message}` }, { status: 500 });
  }

  // Insert in batches via upsert
  let inserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase.from('shopify_gift_cards_staging').upsert(batch, { onConflict: 'id' });
    if (error) {
      return NextResponse.json(
        { error: `insert (batch ${i / BATCH + 1}): ${error.message}`, inserted },
        { status: 500 }
      );
    }
    inserted += batch.length;
  }

  return NextResponse.json({
    rows_parsed: parsed.data.length,
    rows_inserted: inserted,
    enabled_count: records.filter((r) => r.enabled).length,
  });
}
