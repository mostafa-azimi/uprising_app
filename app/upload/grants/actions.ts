'use server';

import Papa from 'papaparse';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import {
  RiseRowSchema,
  processRiseRow,
  type RowResult,
  type RiseRow,
} from '@/lib/grants';

/**
 * Always create a fresh event row per upload — each upload is treated as its
 * own historical event by admins, even if names collide.
 */
async function createNewEvent(args: {
  name: string;
  host?: string;
  uploadedBy?: string;
  sourceFilename?: string;
}): Promise<string> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from('events')
    .insert({
      name: args.name,
      host: args.host,
      uploaded_by: args.uploadedBy,
      source_filename: args.sourceFilename,
      total_grants_count: 0,
      total_grants_amount: 0,
      status: 'completed',
      kind: 'upload',
    })
    .select('id')
    .single();
  if (error) throw new Error(`event insert: ${error.message}`);
  return data.id;
}

export interface UploadOutcome {
  ok: boolean;
  run_id: string;
  totalRows: number;
  succeeded: number;
  failed: number;
  totalAmount: number;
  durationMs: number;
  results: RowResult[];
  campaigns: Array<{ name: string; eventId: string; rowCount: number }>;
  message?: string;
}

function makeRunId(): string {
  return `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function log(runId: string, level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  // Structured single-line JSON so Vercel logs are grep-able by run_id.
  const payload = { run_id: runId, level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
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
  return user;
}

export async function processGrantsUpload(formData: FormData): Promise<UploadOutcome> {
  const runId = makeRunId();
  const t0 = Date.now();
  const user = await requireAdmin();

  const file = formData.get('csv') as File | null;
  const eventName = (formData.get('eventName') as string | null)?.trim() || '';
  if (!file) {
    log(runId, 'error', 'no_file');
    return { ok: false, run_id: runId, totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0, durationMs: Date.now() - t0, results: [], campaigns: [], message: 'No file provided' };
  }
  if (!eventName) {
    log(runId, 'error', 'no_event_name');
    return { ok: false, run_id: runId, totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0, durationMs: Date.now() - t0, results: [], campaigns: [], message: 'Event name is required' };
  }

  log(runId, 'info', 'upload_started', {
    user: user.email,
    file_name: file.name,
    file_size_kb: Math.round(file.size / 1024),
    event_name: eventName,
  });

  const csvText = await file.text();
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length) {
    log(runId, 'error', 'csv_parse_failed', { errors: parsed.errors.slice(0, 5) });
    return {
      ok: false,
      run_id: runId,
      totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0,
      durationMs: Date.now() - t0,
      results: [], campaigns: [],
      message: `CSV parse errors: ${parsed.errors.slice(0, 3).map((e) => e.message).join('; ')}`,
    };
  }

  log(runId, 'info', 'csv_parsed', { row_count: parsed.data.length });

  // Validate every row up front, preserving original index
  const validRows: Array<{ row: RiseRow; rowIndex: number }> = [];
  const earlyFailures: RowResult[] = [];
  parsed.data.forEach((raw, i) => {
    const result = RiseRowSchema.safeParse(raw);
    if (!result.success) {
      earlyFailures.push({
        ok: false,
        rowIndex: i,
        email: raw.customer_email ?? '(missing)',
        error: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        reason: 'invalid',
      });
    } else {
      validRows.push({ row: result.data, rowIndex: i });
    }
  });

  log(runId, 'info', 'rows_validated', { valid: validRows.length, invalid: earlyFailures.length });

  if (validRows.length === 0) {
    log(runId, 'error', 'no_valid_rows');
    return {
      ok: false,
      run_id: runId,
      totalRows: parsed.data.length,
      succeeded: 0,
      failed: earlyFailures.length,
      totalAmount: 0,
      durationMs: Date.now() - t0,
      results: earlyFailures,
      campaigns: [],
      message: 'No valid rows in CSV',
    };
  }

  // Each upload is one event named by the admin. We always create a new event
  // row for each upload (timestamped), so re-uploading the same name doesn't
  // merge into a prior import — admins use unique names per upload (e.g.
  // "April 28 - NADGT CO Premier") and want each as a distinct historical event.
  const host = eventName.includes(' - ') ? eventName.split(' - ')[0] : undefined;
  const eventId = await createNewEvent({
    name: eventName,
    host,
    uploadedBy: user.id,
    sourceFilename: file.name,
  });
  log(runId, 'info', 'event_created', { event_id: eventId, event_name: eventName });
  const campaignRecords: Array<{ name: string; eventId: string; rowCount: number }> = [
    { name: eventName, eventId, rowCount: validRows.length },
  ];

  // Process rows sequentially (rate-limit safe)
  const results: RowResult[] = [...earlyFailures];
  let succeeded = 0;
  let totalAmount = 0;

  log(runId, 'info', 'processing_started', { rows: validRows.length });
  let processed = 0;
  for (const { row, rowIndex } of validRows) {
    const rowT0 = Date.now();
    const result = await processRiseRow({
      rowIndex, row, eventId,
      uploadedBy: user.id,
      uploadedByEmail: user.email ?? null,
      runId,
    });
    results.push(result);
    if (result.ok) {
      succeeded++;
      totalAmount += result.amount;
    } else {
      log(runId, 'warn', 'row_failed', {
        row_index: rowIndex,
        email: result.email,
        reason: result.reason,
        error: result.error,
        ms: Date.now() - rowT0,
      });
    }
    processed++;
    if (processed % 10 === 0 || processed === validRows.length) {
      log(runId, 'info', 'progress', {
        processed,
        total: validRows.length,
        succeeded,
        failed: results.length - succeeded,
      });
    }
  }

  const totalAmountRounded = Math.round(totalAmount * 100) / 100;
  log(runId, 'info', 'upload_complete', {
    duration_ms: Date.now() - t0,
    total_rows: parsed.data.length,
    succeeded,
    failed: results.length - succeeded,
    total_amount: totalAmountRounded,
  });

  return {
    ok: true,
    run_id: runId,
    totalRows: parsed.data.length,
    succeeded,
    failed: results.length - succeeded,
    totalAmount: totalAmountRounded,
    durationMs: Date.now() - t0,
    results,
    campaigns: campaignRecords,
  };
}
