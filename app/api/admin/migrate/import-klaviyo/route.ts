import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdminUser, parseDecimal, parseDate, parseTimestamp, clean } from '@/lib/migrate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface KlaviyoRow {
  Email?: string;
  'First Name'?: string;
  'Last Name'?: string;
  'Klaviyo Profile ID'?: string;     // not always present in exports
  loyalty_card_code?: string;
  loyalty_card_balance?: string;
  last_reward?: string;
  last_event_date?: string;
  expiration_date?: string;
}

const BATCH = 500;

// Some Klaviyo exports use slight column-name variations. Normalize via a
// case-insensitive fallback lookup so we tolerate small differences.
function getCi(row: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] != null && row[k]?.trim() !== '') return row[k];
  }
  // case-insensitive scan
  const wantedLower = keys.map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(row)) {
    if (wantedLower.includes(k.trim().toLowerCase()) && v != null && v.trim() !== '') return v;
  }
  return undefined;
}

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
  const parsed = Papa.parse<KlaviyoRow>(csvText.trim(), {
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

  const records = parsed.data
    .map((r) => {
      const row = r as unknown as Record<string, string | undefined>;
      const email = clean(getCi(row, 'Email', 'email'))?.toLowerCase() ?? null;
      if (!email) return null;
      return {
        email,
        first_name: clean(getCi(row, 'First Name', 'first_name')),
        last_name: clean(getCi(row, 'Last Name', 'last_name')),
        klaviyo_profile_id: clean(getCi(row, 'Klaviyo Profile ID', 'profile_id', 'id')),
        loyalty_card_code: clean(getCi(row, 'loyalty_card_code', 'Loyalty Card Code')),
        loyalty_card_balance: parseDecimal(getCi(row, 'loyalty_card_balance', 'Loyalty Card Balance')),
        last_reward: parseDecimal(getCi(row, 'last_reward', 'Last Reward')),
        last_event_date: parseTimestamp(getCi(row, 'last_event_date', 'Last Event Date')),
        expiration_date: parseDate(getCi(row, 'expiration_date', 'Expiration Date')),
        imported_at: new Date().toISOString(),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const supabase = createSupabaseServiceClient();

  // Wipe staging — full replace each upload
  const { error: delErr } = await supabase.from('klaviyo_profiles_staging').delete().neq('email', '___sentinel___');
  if (delErr) {
    return NextResponse.json({ error: `staging clear: ${delErr.message}` }, { status: 500 });
  }

  let inserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase.from('klaviyo_profiles_staging').upsert(batch, { onConflict: 'email' });
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
    with_loyalty_code: records.filter((r) => r.loyalty_card_code).length,
    with_balance: records.filter((r) => (r.loyalty_card_balance ?? 0) > 0).length,
  });
}
