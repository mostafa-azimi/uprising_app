import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * TEMPORARY TOOL.
 *
 * Phase 1 — Preview.
 * Parses an uploaded CSV with columns `email, loyalty_card_code` and reports
 * what would happen on apply. Read-only; no DB writes.
 */

interface CsvRow {
  email?: string;
  loyalty_card_code?: string;
}

export interface UploadCodeRowMatched {
  csv_row: number;
  email: string;
  customer_id: string;
  csv_code: string;
  current_code: string | null;
  status: 'new' | 'unchanged' | 'conflict';
}

export interface UploadCodeRowMissing {
  csv_row: number;
  email: string;
  csv_code: string;
}

interface PreviewResult {
  ok: boolean;
  generated_at: string;
  csv_total_rows: number;
  csv_duplicate_emails: string[];
  matched: UploadCodeRowMatched[];
  not_found: UploadCodeRowMissing[];
  invalid_rows: Array<{ csv_row: number; reason: string; raw: CsvRow }>;
  counts: {
    new: number;
    unchanged: number;
    conflict: number;
    not_found: number;
    invalid: number;
  };
  duration_ms: number;
}

const PAGE = 1000;

function clean(v: string | undefined | null): string {
  if (v == null) return '';
  return String(v).trim();
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  try {
    try {
      await requireAdmin();
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 401 });
    }

    const form = await request.formData();
    const file = form.get('csv') as File | null;
    if (!file) return NextResponse.json({ error: 'No CSV uploaded' }, { status: 400 });

    const csvText = await file.text();
    const parsed = Papa.parse<CsvRow>(csvText.trim(), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim().toLowerCase(),
    });
    if (parsed.errors.length) {
      return NextResponse.json(
        { error: `CSV parse: ${parsed.errors.slice(0, 3).map((e) => e.message).join('; ')}` },
        { status: 400 }
      );
    }

    // Required columns
    const headerSample = parsed.meta.fields ?? [];
    if (!headerSample.includes('email') || !headerSample.includes('loyalty_card_code')) {
      return NextResponse.json(
        {
          error: `CSV must have columns named exactly 'email' and 'loyalty_card_code'. Got: ${headerSample.join(', ') || '(none)'}`,
        },
        { status: 400 }
      );
    }

    // Validate every row, normalize, and detect duplicates
    interface ValidRow {
      csv_row: number;
      email: string;
      code: string;
    }
    const validRows: ValidRow[] = [];
    const invalid: PreviewResult['invalid_rows'] = [];
    const seenEmails = new Map<string, number>();
    const duplicates = new Set<string>();

    parsed.data.forEach((row, idx) => {
      const csvRow = idx + 2; // header is row 1
      const email = clean(row.email).toLowerCase();
      const code = clean(row.loyalty_card_code);

      if (!email) {
        invalid.push({ csv_row: csvRow, reason: 'missing email', raw: row });
        return;
      }
      // Light email shape check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        invalid.push({ csv_row: csvRow, reason: `invalid email '${email}'`, raw: row });
        return;
      }
      if (!code) {
        invalid.push({ csv_row: csvRow, reason: 'missing loyalty_card_code', raw: row });
        return;
      }

      if (seenEmails.has(email)) {
        duplicates.add(email);
      } else {
        seenEmails.set(email, csvRow);
        validRows.push({ csv_row: csvRow, email, code });
      }
    });

    // Look up matching customers in chunks
    const supabase = createSupabaseServiceClient();
    const customerByEmail = new Map<string, { id: string; loyalty_card_code: string | null }>();
    const allEmails = validRows.map((r) => r.email);
    for (let i = 0; i < allEmails.length; i += PAGE) {
      const slice = allEmails.slice(i, i + PAGE);
      const { data, error } = await supabase
        .from('customers')
        .select('id, email, loyalty_card_code')
        .in('email', slice);
      if (error) {
        return NextResponse.json({ error: `customers query: ${error.message}` }, { status: 500 });
      }
      (data ?? []).forEach((c) =>
        customerByEmail.set((c.email ?? '').toLowerCase(), {
          id: c.id,
          loyalty_card_code: c.loyalty_card_code,
        })
      );
    }

    const matched: UploadCodeRowMatched[] = [];
    const notFound: UploadCodeRowMissing[] = [];
    let countNew = 0, countUnchanged = 0, countConflict = 0;
    for (const v of validRows) {
      const cust = customerByEmail.get(v.email);
      if (!cust) {
        notFound.push({ csv_row: v.csv_row, email: v.email, csv_code: v.code });
        continue;
      }
      const current = cust.loyalty_card_code;
      let status: 'new' | 'unchanged' | 'conflict';
      if (current == null || current === '') {
        status = 'new';
        countNew++;
      } else if (current === v.code) {
        status = 'unchanged';
        countUnchanged++;
      } else {
        status = 'conflict';
        countConflict++;
      }
      matched.push({
        csv_row: v.csv_row,
        email: v.email,
        customer_id: cust.id,
        csv_code: v.code,
        current_code: current,
        status,
      });
    }

    const result: PreviewResult = {
      ok: true,
      generated_at: new Date().toISOString(),
      csv_total_rows: parsed.data.length,
      csv_duplicate_emails: Array.from(duplicates),
      matched,
      not_found: notFound,
      invalid_rows: invalid,
      counts: {
        new: countNew,
        unchanged: countUnchanged,
        conflict: countConflict,
        not_found: notFound.length,
        invalid: invalid.length,
      },
      duration_ms: Date.now() - t0,
    };
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `Server error after ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
