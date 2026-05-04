import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Backfill `shopify_gift_card_id`, `loyalty_card_code`, and
 * `shopify_gift_card_last4` on customers where any of those are missing,
 * using the Master Rise CSV as the source of truth.
 *
 * The Master Rise CSV has `shopify_gift_card_id` and `customer_email` on
 * every row, so no Shopify search is needed. We pick the most recent
 * non-disabled, non-deleted card per email.
 *
 * No grant inserts. No Shopify API calls. No Klaviyo API calls.
 * Only updates customers that already exist in our DB (no inserts).
 * Skips customers that are already fully linked.
 *
 * Performance: collects all updates in memory then applies them with
 * concurrency 25 to fit comfortably under Vercel's 60s function limit.
 */

interface MasterRow {
  shopify_gift_card_id?: string;
  code?: string;
  customer_email?: string;
  created_at?: string;
  disabled_at?: string;
  deleted_at?: string;
}

interface SampleLink {
  email: string;
  shopify_gift_card_id: string;
  loyalty_card_code: string;
  last4: string;
}

interface LinkResult {
  csv_rows: number;
  customers_in_csv: number;
  customers_in_db: number;
  customers_already_linked: number;
  customers_linked: number;
  customers_failed: number;
  customers_in_csv_not_in_db: number;
  customers_with_no_eligible_card: number;
  duration_ms: number;
  sample_links: SampleLink[];
  emails_not_in_db_sample: string[];
}

const PAGE = 1000;
const WRITE_CONCURRENCY = 25;

function clean(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function parseCreatedAtMs(s: string | undefined): number {
  if (!s) return 0;
  const t = s.trim();
  if (!t) return 0;
  const asIso = t.includes('T') ? t : t.replace(' ', 'T') + 'Z';
  const d = new Date(asIso);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const payload = { tool: 'link-gift-cards', level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
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
    log('info', 'started', { file_name: file.name, file_size_kb: Math.round(file.size / 1024) });

    const csvText = await file.text();
    const parsed = Papa.parse<MasterRow>(csvText.trim(), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    });
    if (parsed.errors.length) {
      log('error', 'csv_parse_failed', { errors: parsed.errors.slice(0, 3) });
      return NextResponse.json(
        { error: `CSV parse: ${parsed.errors.slice(0, 3).map((e) => e.message).join('; ')}` },
        { status: 400 }
      );
    }
    log('info', 'csv_parsed', { row_count: parsed.data.length });

    // Build per-email "best card" map: most recent non-disabled, non-deleted card.
    interface Candidate {
      shopify_gift_card_id: string;
      code: string;
      last4: string;
      created_at_ms: number;
    }
    const bestByEmail = new Map<string, Candidate>();
    const allEmailsInCsv = new Set<string>();

    for (const r of parsed.data) {
      const email = clean(r.customer_email)?.toLowerCase();
      if (!email) continue;
      allEmailsInCsv.add(email);

      const giftCardId = clean(r.shopify_gift_card_id);
      const code = clean(r.code);
      if (!giftCardId || !code) continue;

      const isDisabled = !!clean(r.disabled_at) || !!clean(r.deleted_at);
      if (isDisabled) continue;

      const ts = parseCreatedAtMs(r.created_at);
      const candidate: Candidate = {
        shopify_gift_card_id: `gid://shopify/GiftCard/${giftCardId}`,
        code,
        last4: code.slice(-4),
        created_at_ms: ts,
      };

      const existing = bestByEmail.get(email);
      if (!existing || ts > existing.created_at_ms) {
        bestByEmail.set(email, candidate);
      }
    }
    log('info', 'csv_grouped', {
      unique_emails: allEmailsInCsv.size,
      emails_with_eligible_card: bestByEmail.size,
    });

    const result: LinkResult = {
      csv_rows: parsed.data.length,
      customers_in_csv: allEmailsInCsv.size,
      customers_in_db: 0,
      customers_already_linked: 0,
      customers_linked: 0,
      customers_failed: 0,
      customers_in_csv_not_in_db: 0,
      customers_with_no_eligible_card: 0,
      duration_ms: 0,
      sample_links: [],
      emails_not_in_db_sample: [],
    };

    const supabase = createSupabaseServiceClient();

    // Phase 1: read every customer in pages and decide what (if anything) to update.
    interface PendingUpdate {
      id: string;
      email: string;
      update: Record<string, string>;
      best: Candidate;
    }
    const pending: PendingUpdate[] = [];
    const dbEmails = new Set<string>();

    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('customers')
        .select('id, email, shopify_gift_card_id, loyalty_card_code, shopify_gift_card_last4')
        .range(from, from + PAGE - 1);
      if (error) {
        log('error', 'customers_query_failed', { error: error.message, from });
        return NextResponse.json({ error: `customers query: ${error.message}` }, { status: 500 });
      }
      if (!data || data.length === 0) break;

      for (const c of data) {
        const email = (c.email ?? '').toLowerCase();
        dbEmails.add(email);
        result.customers_in_db++;

        if (c.shopify_gift_card_id && c.loyalty_card_code && c.shopify_gift_card_last4) {
          result.customers_already_linked++;
          continue;
        }

        const best = bestByEmail.get(email);
        if (!best) {
          if (allEmailsInCsv.has(email)) {
            result.customers_with_no_eligible_card++;
          }
          continue;
        }

        const update: Record<string, string> = {};
        if (!c.shopify_gift_card_id) update.shopify_gift_card_id = best.shopify_gift_card_id;
        if (!c.loyalty_card_code) update.loyalty_card_code = best.code;
        if (!c.shopify_gift_card_last4) update.shopify_gift_card_last4 = best.last4;

        if (Object.keys(update).length === 0) {
          result.customers_already_linked++;
          continue;
        }

        pending.push({ id: c.id, email, update, best });
      }

      if (data.length < PAGE) break;
      from += PAGE;
    }
    log('info', 'pending_updates_collected', {
      customers_in_db: result.customers_in_db,
      already_linked: result.customers_already_linked,
      to_update: pending.length,
    });

    // Phase 2: apply updates with concurrency
    for (let i = 0; i < pending.length; i += WRITE_CONCURRENCY) {
      const batch = pending.slice(i, i + WRITE_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((p) =>
          supabase.from('customers').update(p.update).eq('id', p.id).then(({ error }) => {
            if (error) throw new Error(error.message);
            return p;
          })
        )
      );

      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        const p = batch[j];
        if (r.status === 'fulfilled') {
          result.customers_linked++;
          if (result.sample_links.length < 20) {
            result.sample_links.push({
              email: p.email,
              shopify_gift_card_id: p.best.shopify_gift_card_id,
              loyalty_card_code: p.best.code,
              last4: p.best.last4,
            });
          }
        } else {
          result.customers_failed++;
          log('warn', 'update_failed', { email: p.email, error: (r.reason as Error)?.message ?? String(r.reason) });
        }
      }

      if ((i + WRITE_CONCURRENCY) % 500 === 0 || i + WRITE_CONCURRENCY >= pending.length) {
        log('info', 'progress', {
          processed: Math.min(i + WRITE_CONCURRENCY, pending.length),
          total: pending.length,
          linked: result.customers_linked,
          failed: result.customers_failed,
        });
      }
    }

    // Emails in CSV but not in our DB
    const notInDb: string[] = [];
    for (const email of allEmailsInCsv) {
      if (!dbEmails.has(email)) notInDb.push(email);
    }
    result.customers_in_csv_not_in_db = notInDb.length;
    result.emails_not_in_db_sample = notInDb.slice(0, 50);

    result.duration_ms = Date.now() - t0;
    log('info', 'completed', {
      duration_ms: result.duration_ms,
      linked: result.customers_linked,
      failed: result.customers_failed,
    });
    return NextResponse.json(result);
  } catch (e) {
    const errMsg = (e as Error).message ?? String(e);
    log('error', 'unhandled_exception', {
      error: errMsg,
      stack: ((e as Error).stack ?? '').slice(0, 2000),
      duration_ms: Date.now() - t0,
    });
    return NextResponse.json(
      { error: `Server error after ${Math.round((Date.now() - t0) / 1000)}s: ${errMsg}` },
      { status: 500 }
    );
  }
}
