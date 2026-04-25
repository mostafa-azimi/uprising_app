'use server';

import Papa from 'papaparse';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  RiseRowSchema,
  groupRowsByCampaign,
  findOrCreateEvent,
  processRiseRow,
  type RowResult,
  type RiseRow,
} from '@/lib/grants';

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
  const explicitEventName = (formData.get('eventName') as string | null)?.trim() || '';
  if (!file) {
    return { ok: false, totalRows: 0, succeeded: 0, failed: 0, totalAmount: 0, results: [], campaigns: [], message: 'No file provided' };
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

  // Determine event grouping: if user provided an explicit name, all rows go
  // into one event. Otherwise group by `note` column (existing behavior).
  const justRows = validRows.map((v) => v.row);
  const campaignRecords: Array<{ name: string; eventId: string; rowCount: number }> = [];
  const eventIdByCampaign = new Map<string, string>();

  if (explicitEventName) {
    // Single event for the whole upload. findOrCreateEvent merges by exact
    // name — so re-uploading with the same name extends the same event,
    // which matches our re-upload regression test behavior.
    const host = explicitEventName.includes(' - ') ? explicitEventName.split(' - ')[0] : undefined;
    const eventId = await findOrCreateEvent({
      name: explicitEventName,
      host,
      uploadedBy: user.id,
      sourceFilename: file.name,
    });
    eventIdByCampaign.set('__all__', eventId);
    campaignRecords.push({ name: explicitEventName, eventId, rowCount: validRows.length });
  } else {
    const groups = groupRowsByCampaign(justRows);
    for (const [campaignName, group] of groups.entries()) {
      const eventId = await findOrCreateEvent({
        name: campaignName,
        host: group.host,
        uploadedBy: user.id,
        sourceFilename: file.name,
      });
      eventIdByCampaign.set(campaignName, eventId);
      campaignRecords.push({ name: campaignName, eventId, rowCount: group.rows.length });
    }
  }

  // Process rows sequentially (rate-limit safe)
  const results: RowResult[] = [...earlyFailures];
  let succeeded = 0;
  let totalAmount = 0;

  for (const { row, rowIndex } of validRows) {
    const eventId = explicitEventName
      ? eventIdByCampaign.get('__all__')!
      : eventIdByCampaign.get((row.note || row.reason || 'Untitled').trim())!;
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
