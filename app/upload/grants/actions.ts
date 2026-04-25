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
    })
    .select('id')
    .single();
  if (error) throw new Error(`event insert: ${error.message}`);
  return data.id;
}

export interface UploadOutcome {
  ok: boolean;
  totalRows: number;
  succeeded: number;
  failed: number;
  totalAmount: number;
  results: RowResult[];
  campaigns: Array<{ name: string; eventId: string; rowCount: number }>;
  message?: string;
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
  const user = await requireAdmin();

  const file = formData.get('csv') as File | null;
  const eventName = (formData.get('eventName') as string | null)?.trim() || '';
  if (!file) {
    return { ok: false, totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0, results: [], campaigns: [], message: 'No file provided' };
  }
  if (!eventName) {
    return { ok: false, totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0, results: [], campaigns: [], message: 'Event name is required' };
  }

  const csvText = await file.text();
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length) {
    return {
      ok: false,
      totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0,
      results: [], campaigns: [],
      message: `CSV parse errors: ${parsed.errors.slice(0, 3).map((e) => e.message).join('; ')}`,
    };
  }

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

  if (validRows.length === 0) {
    return {
      ok: false,
      totalRows: parsed.data.length,
      succeeded: 0,
      failed: earlyFailures.length,
      totalAmount: 0,
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
  const campaignRecords: Array<{ name: string; eventId: string; rowCount: number }> = [
    { name: eventName, eventId, rowCount: validRows.length },
  ];

  // Process rows sequentially (rate-limit safe)
  const results: RowResult[] = [...earlyFailures];
  let succeeded = 0;
  let totalAmount = 0;

  for (const { row, rowIndex } of validRows) {
    const result = await processRiseRow({ rowIndex, row, eventId, uploadedBy: user.id });
    results.push(result);
    if (result.ok) {
      succeeded++;
      totalAmount += result.amount;
    }
  }

  return {
    ok: true,
    totalRows: parsed.data.length,
    succeeded,
    failed: results.length - succeeded,
    totalAmount: Math.round(totalAmount * 100) / 100,
    results,
    campaigns: campaignRecords,
  };
}
