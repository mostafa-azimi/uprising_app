/**
 * Grant processing — issue store credit (orphan Shopify gift card) to one customer.
 *
 * Per Rise's actual model:
 *   - Each customer has ONE orphan gift card (no customer link, no email notification).
 *   - The Shopify gift card code IS the loyalty_card_code we push to Klaviyo.
 *   - First grant creates the card (initialValue = grant amount).
 *   - Subsequent grants call giftCardCredit on the existing card.
 *   - Per-grant expiration is tracked in our DB; on expiration we call giftCardDebit.
 */

import { z } from 'zod';
import { createSupabaseServiceClient } from './supabase/server';
import { giftCardCreate, giftCardCredit, findGiftCardsByLast4 } from './shopify';
import { upsertProfile } from './klaviyo';
import { findOrCreateCustomerByEmail, NotInKlaviyoError, recomputeBalance, type LocalCustomer } from './customers';

// ----- CSV row schema -----
export const RiseRowSchema = z.object({
  code: z.string().optional().default(''),
  adjust_amount: z.coerce.number().positive('amount must be > 0'),
  expires_on: z.string().regex(/^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{4}-\d{2}-\d{2}$/, 'expires_on must be MM/DD/YYYY or YYYY-MM-DD'),
  customer_name: z.string().optional().default(''),
  customer_email: z.string().email('invalid email'),
  reason: z.string().optional().default(''),
  note: z.string().optional().default(''),
});
export type RiseRow = z.infer<typeof RiseRowSchema>;

export type RowResult =
  | { ok: true; rowIndex: number; email: string; grantId: string; amount: number; expiresOn: string; campaignName: string }
  | { ok: false; rowIndex: number; email: string; error: string; reason: 'not_in_klaviyo' | 'shopify_failed' | 'db_failed' | 'invalid' };

// ----- Helpers -----
function normalizeDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [m, day, y] = d.split('/');
  return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function splitName(name: string | undefined): { first?: string; last?: string } {
  if (!name) return {};
  const trimmed = name.trim();
  if (!trimmed) return {};
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export async function findOrCreateEvent(args: {
  name: string;
  host?: string;
  eventDate?: string;
  uploadedBy?: string;
  sourceFilename?: string;
}): Promise<string> {
  const supabase = createSupabaseServiceClient();
  const { data: existing } = await supabase
    .from('events')
    .select('id')
    .eq('name', args.name)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('events')
    .insert({
      name: args.name,
      host: args.host,
      event_date: args.eventDate,
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

interface GiftCardOutcome {
  id: string;
  code: string;       // full code (loyalty_card_code)
  last4: string;
  creditTxnId: string | null;
}

/**
 * Apply a grant to the customer's orphan gift card.
 *
 * Three paths:
 *   A. Customer already has shopify_gift_card_id → call giftCardCredit on it.
 *   B. Customer has loyalty_card_code from a Rise migration but no gift card ID
 *      yet → search Shopify by last 4, find the matching card, link it, then credit.
 *   C. Brand new customer (no code anywhere) → giftCardCreate with grant amount as
 *      initialValue, capture giftCardCode and use it as the loyalty_card_code.
 */
async function applyGrantToGiftCard(args: {
  customer: LocalCustomer;
  amount: number;
  noteForShopify: string;
  expiresOn: string;
}): Promise<GiftCardOutcome> {
  const { customer, amount, noteForShopify, expiresOn } = args;
  const supabase = createSupabaseServiceClient();

  // --- Path A: existing gift card ID ---
  if (customer.shopify_gift_card_id && customer.loyalty_card_code) {
    const credit = await giftCardCredit(customer.shopify_gift_card_id, amount.toFixed(2), noteForShopify);
    return {
      id: customer.shopify_gift_card_id,
      code: customer.loyalty_card_code,
      last4: customer.shopify_gift_card_last4 ?? customer.loyalty_card_code.slice(-4),
      creditTxnId: credit.transactionId,
    };
  }

  // --- Path B: loyalty_card_code from Rise migration, no ID yet ---
  if (customer.loyalty_card_code && !customer.shopify_gift_card_id) {
    const last4 = customer.loyalty_card_code.slice(-4);
    const candidates = await findGiftCardsByLast4(last4);
    const exactMatches = candidates.filter((c) => c.lastCharacters === last4);
    const enabledMatches = exactMatches.filter((c) => c.enabled);

    if (enabledMatches.length === 0) {
      const diag = `last4=${last4} candidates_returned=${candidates.length} exact_match=${exactMatches.length} enabled=${enabledMatches.length} disabled=${exactMatches.length - enabledMatches.length}`;
      throw new Error(
        `No matching enabled Shopify gift card for loyalty_card_code ${customer.loyalty_card_code}. ${diag}. ` +
        `Either the gift card was deleted/disabled, or Shopify search isn't indexing it. ` +
        `Manually link via SQL: update customers set shopify_gift_card_id='gid://shopify/GiftCard/<ID>' where email='${customer.email}'.`
      );
    }
    if (enabledMatches.length > 1) {
      throw new Error(
        `Multiple enabled gift cards match last4=${last4} (${enabledMatches.length}). Cannot disambiguate. Link manually via SQL.`
      );
    }

    const match = enabledMatches[0];
    const { error: linkErr } = await supabase
      .from('customers')
      .update({
        shopify_gift_card_id: match.id,
        shopify_gift_card_last4: match.lastCharacters,
      })
      .eq('id', customer.id);
    if (linkErr) throw new Error(`gift card link update: ${linkErr.message}`);

    const credit = await giftCardCredit(match.id, amount.toFixed(2), noteForShopify);
    return {
      id: match.id,
      code: customer.loyalty_card_code,
      last4: match.lastCharacters ?? last4,
      creditTxnId: credit.transactionId,
    };
  }

  // --- Path C: brand new customer ---
  const card = await giftCardCreate({
    initialValue: amount.toFixed(2),
    note: noteForShopify,
    // We deliberately omit `expiresOn` on the gift card itself — Shopify only
    // supports one expiration per card, but we need per-grant expiration.
    // Per-grant expiration lives in our `grants` table; we debit on expiration.
  });

  if (!card.code) {
    throw new Error('giftCardCreate returned no code (Shopify only returns code at creation; check 2025-04+ schema)');
  }

  const last4 = card.lastCharacters ?? card.code.slice(-4);

  const { error: updErr } = await supabase
    .from('customers')
    .update({
      shopify_gift_card_id: card.id,
      loyalty_card_code: card.code,
      shopify_gift_card_last4: last4,
    })
    .eq('id', customer.id);
  if (updErr) throw new Error(`customers gift card update: ${updErr.message}`);

  return { id: card.id, code: card.code, last4, creditTxnId: null };
}

function rowLog(runId: string | undefined, level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown>) {
  if (!runId) return;
  const payload = { run_id: runId, level, event, ts: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

export async function processRiseRow(args: {
  rowIndex: number;
  row: RiseRow;
  eventId: string;
  uploadedBy?: string;
  uploadedByEmail?: string | null;
  runId?: string;
}): Promise<RowResult> {
  const { rowIndex, row, eventId, runId } = args;
  const email = row.customer_email.trim().toLowerCase();
  const supabase = createSupabaseServiceClient();
  const { first: csvFirst, last: csvLast } = splitName(row.customer_name);
  const tStart = Date.now();

  // --- 1. Find or create local customer (Klaviyo gate) ---
  rowLog(runId, 'info', 'row_started', { row_index: rowIndex, email, amount: row.adjust_amount });
  let lookup: { customer: LocalCustomer; klaviyo: { id: string; properties: Record<string, unknown> } };
  try {
    lookup = await findOrCreateCustomerByEmail(email, csvFirst, csvLast);
    rowLog(runId, 'info', 'row_klaviyo_found', {
      row_index: rowIndex, email,
      klaviyo_profile_id: lookup.klaviyo.id,
      had_loyalty_code: !!lookup.klaviyo.properties.loyalty_card_code,
    });
  } catch (e) {
    if (e instanceof NotInKlaviyoError) {
      rowLog(runId, 'warn', 'row_not_in_klaviyo', { row_index: rowIndex, email });
      return { ok: false, rowIndex, email, error: e.message, reason: 'not_in_klaviyo' };
    }
    rowLog(runId, 'error', 'row_klaviyo_lookup_failed', { row_index: rowIndex, email, error: (e as Error).message });
    return { ok: false, rowIndex, email, error: (e as Error).message, reason: 'db_failed' };
  }
  let customer = lookup.customer;

  // --- 2. If our DB has no loyalty_card_code yet but Klaviyo does, hydrate from Klaviyo ---
  if (!customer.loyalty_card_code) {
    const fromKlaviyo = typeof lookup.klaviyo.properties.loyalty_card_code === 'string'
      ? (lookup.klaviyo.properties.loyalty_card_code as string).trim()
      : '';
    if (fromKlaviyo) {
      const { error } = await supabase
        .from('customers')
        .update({ loyalty_card_code: fromKlaviyo })
        .eq('id', customer.id);
      if (error) {
        return { ok: false, rowIndex, email, error: `customer code update: ${error.message}`, reason: 'db_failed' };
      }
      customer = { ...customer, loyalty_card_code: fromKlaviyo };
    }
  }

  const expiresOn = normalizeDate(row.expires_on);
  const amount = Number(row.adjust_amount);

  // --- 3. Apply to Shopify (orphan gift card) ---
  rowLog(runId, 'info', 'row_shopify_attempt', {
    row_index: rowIndex, email, amount, expires_on: expiresOn,
    has_existing_card: !!customer.shopify_gift_card_id,
    has_loyalty_code: !!customer.loyalty_card_code,
  });
  let giftCard: GiftCardOutcome;
  const tShopify = Date.now();
  try {
    giftCard = await applyGrantToGiftCard({
      customer,
      amount,
      noteForShopify: `Uprising grant — event:${eventId} — ${row.note || row.reason || ''} — exp:${expiresOn}`,
      expiresOn,
    });
    rowLog(runId, 'info', 'row_shopify_ok', {
      row_index: rowIndex, email,
      gift_card_id: giftCard.id, last4: giftCard.last4, ms: Date.now() - tShopify,
    });
    // Persistent audit (success) so we can see what happened later
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'giftCard_credit_or_create',
      entity_id: customer.id,
      ok: true,
      status_code: 200,
      request_body: { email, amount, expires_on: expiresOn, run_id: runId },
      response_body: { gift_card_id: giftCard.id, last4: giftCard.last4 },
    });
    customer = {
      ...customer,
      shopify_gift_card_id: giftCard.id,
      shopify_gift_card_last4: giftCard.last4,
      loyalty_card_code: giftCard.code,
    };
  } catch (e) {
    const errMsg = (e as Error).message;
    rowLog(runId, 'error', 'row_shopify_failed', {
      row_index: rowIndex, email, amount, expires_on: expiresOn,
      error: errMsg, ms: Date.now() - tShopify,
    });
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'giftCard_credit_or_create',
      entity_id: customer.id,
      ok: false,
      error_message: errMsg,
      request_body: {
        email,
        amount,
        expiresOn,
        run_id: runId,
        existing_gift_card_id: customer.shopify_gift_card_id,
        existing_loyalty_card_code: customer.loyalty_card_code,
      },
      response_body: { stack: ((e as Error).stack ?? '').slice(0, 2000) },
    });
    return { ok: false, rowIndex, email, error: `Shopify: ${errMsg}`, reason: 'shopify_failed' };
  }

  // --- 4. Insert grant + ledger ---
  let grantId: string;
  try {
    const { data: grant, error: gErr } = await supabase
      .from('grants')
      .insert({
        customer_id: customer.id,
        event_id: eventId,
        initial_amount: amount,
        remaining_amount: amount,
        expires_on: expiresOn,
        reason: row.reason || null,
        note: row.note || null,
        status: 'active',
      })
      .select('id')
      .single();
    if (gErr) throw new Error(gErr.message);
    grantId = grant.id;

    const { error: lErr } = await supabase.from('ledger').insert({
      customer_id: customer.id,
      grant_id: grantId,
      type: 'issue',
      amount,
      shopify_transaction_id: giftCard.creditTxnId,
      description: row.note || row.reason || 'Issue',
      created_by: args.uploadedBy ?? null,
      created_by_email: args.uploadedByEmail ?? null,
    });
    if (lErr) throw new Error(lErr.message);
    rowLog(runId, 'info', 'row_db_inserted', { row_index: rowIndex, email, grant_id: grantId });
  } catch (e) {
    rowLog(runId, 'error', 'row_db_insert_failed', { row_index: rowIndex, email, error: (e as Error).message });
    return { ok: false, rowIndex, email, error: `DB: ${(e as Error).message}`, reason: 'db_failed' };
  }

  // --- 5. Recompute cached balance + sync customers.expiration_date ---
  let newBalance = customer.total_balance_cached;
  try {
    newBalance = await recomputeBalance(customer.id);
    rowLog(runId, 'info', 'row_balance_recomputed', { row_index: rowIndex, email, new_balance: newBalance });
  } catch (e) {
    rowLog(runId, 'error', 'row_recompute_failed', { row_index: rowIndex, email, error: (e as Error).message });
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'recompute_balance',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

  // Update the customer's denormalized expiration_date to this newest grant's expires_on
  await supabase
    .from('customers')
    .update({ expiration_date: expiresOn })
    .eq('id', customer.id);

  // --- 6. Push 4 Rise-compatible Klaviyo properties ---
  const tKlaviyo = Date.now();
  try {
    await upsertProfile({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_code: giftCard.code,
        loyalty_card_balance: newBalance,
        last_reward: amount,
        expiration_date: expiresOn,
      },
    });
    rowLog(runId, 'info', 'row_klaviyo_pushed', {
      row_index: rowIndex, email,
      loyalty_card_balance: newBalance,
      loyalty_card_code: giftCard.code,
      ms: Date.now() - tKlaviyo,
    });
  } catch (e) {
    rowLog(runId, 'error', 'row_klaviyo_push_failed', {
      row_index: rowIndex, email,
      error: (e as Error).message,
      ms: Date.now() - tKlaviyo,
    });
    await supabase.from('sync_log').insert({
      target: 'klaviyo',
      operation: 'profile_property_sync',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

  // --- Bump event aggregates ---
  try {
    const { data: ev } = await supabase
      .from('events')
      .select('total_grants_count, total_grants_amount')
      .eq('id', eventId)
      .single();
    if (ev) {
      await supabase
        .from('events')
        .update({
          total_grants_count: (ev.total_grants_count || 0) + 1,
          total_grants_amount: Number(ev.total_grants_amount || 0) + amount,
        })
        .eq('id', eventId);
    }
  } catch {
    /* non-fatal */
  }

  rowLog(runId, 'info', 'row_success', {
    row_index: rowIndex, email, grant_id: grantId, amount, expires_on: expiresOn,
    total_ms: Date.now() - tStart,
  });

  return {
    ok: true,
    rowIndex,
    email,
    grantId,
    amount,
    expiresOn,
    campaignName: row.note || row.reason || 'Untitled',
  };
}

export function groupRowsByCampaign(rows: RiseRow[]): Map<string, { rows: Array<{ row: RiseRow; rowIndex: number }>; host?: string; eventDate?: string }> {
  const groups = new Map<string, { rows: Array<{ row: RiseRow; rowIndex: number }>; host?: string; eventDate?: string }>();
  rows.forEach((row, i) => {
    const key = (row.note || row.reason || 'Untitled').trim();
    let g = groups.get(key);
    if (!g) {
      const host = key.includes(' - ') ? key.split(' - ')[0] : undefined;
      g = { rows: [], host };
      groups.set(key, g);
    }
    g.rows.push({ row, rowIndex: i });
  });
  return groups;
}
