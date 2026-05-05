import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * TEMPORARY TOOL.
 *
 * Phase 2 — Apply.
 * Receives the matched rows from preview and updates customers.loyalty_card_code
 * (plus shopify_gift_card_last4 derived from the last 4 of the code).
 *
 * No Shopify writes. No grant writes. Customer metadata only.
 */

interface ApplyRow {
  customer_id: string;
  email: string;
  csv_code: string;
  current_code: string | null;
  status: 'new' | 'unchanged' | 'conflict';
}

interface ApplyOutcome {
  customer_id: string;
  email: string;
  status: 'updated' | 'unchanged' | 'skipped_conflict' | 'error';
  detail?: string;
}

interface ApplyResult {
  ok: boolean;
  generated_at: string;
  rows_received: number;
  updated: number;
  unchanged: number;
  skipped_conflict: number;
  errored: number;
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

  let body: { rows?: ApplyRow[]; overwrite_conflicts?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const overwriteConflicts = body.overwrite_conflicts === true;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no rows to apply' }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const result: ApplyResult = {
    ok: true,
    generated_at: new Date().toISOString(),
    rows_received: rows.length,
    updated: 0,
    unchanged: 0,
    skipped_conflict: 0,
    errored: 0,
    duration_ms: 0,
    outcomes: [],
  };

  for (const row of rows) {
    const outcome: ApplyOutcome = {
      customer_id: row.customer_id,
      email: row.email,
      status: 'unchanged',
    };

    try {
      // Re-fetch the customer's current code to detect drift since preview
      const { data: live, error: selErr } = await supabase
        .from('customers')
        .select('loyalty_card_code')
        .eq('id', row.customer_id)
        .maybeSingle();
      if (selErr || !live) throw new Error(selErr?.message ?? 'customer not found');

      const liveCode = live.loyalty_card_code ?? null;

      if (liveCode === row.csv_code) {
        outcome.status = 'unchanged';
        result.unchanged++;
        result.outcomes.push(outcome);
        continue;
      }

      // Conflict: there's a different code already, and user didn't opt in to overwrite
      if (liveCode != null && liveCode !== '' && !overwriteConflicts) {
        outcome.status = 'skipped_conflict';
        outcome.detail = `existing code '${liveCode}' differs from CSV '${row.csv_code}'`;
        result.skipped_conflict++;
        result.outcomes.push(outcome);
        continue;
      }

      const last4 = row.csv_code.slice(-4);
      const { error: updErr } = await supabase
        .from('customers')
        .update({
          loyalty_card_code: row.csv_code,
          shopify_gift_card_last4: last4,
        })
        .eq('id', row.customer_id);
      if (updErr) throw new Error(updErr.message);

      outcome.status = 'updated';
      outcome.detail = liveCode ? `was '${liveCode}', now '${row.csv_code}' (overwrite)` : `set to '${row.csv_code}'`;
      result.updated++;

      // Audit log
      await supabase.from('sync_log').insert({
        target: 'shopify',
        operation: 'upload_loyalty_codes',
        entity_id: row.customer_id,
        ok: true,
        request_body: {
          email: row.email,
          old_code: liveCode,
          new_code: row.csv_code,
          overwrite: overwriteConflicts && liveCode != null,
          actor: user.email,
        },
      });
    } catch (e) {
      outcome.status = 'error';
      outcome.detail = (e as Error).message;
      result.errored++;
    }
    result.outcomes.push(outcome);
  }

  result.duration_ms = Date.now() - t0;
  return NextResponse.json(result);
}
