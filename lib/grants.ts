/**
 * Grant processing — issue store credit to one customer.
 *
 * For each row:
 *   1. Find or create local customer (gates on Klaviyo presence)
 *   2. Ensure a Shopify customer exists (link by email, create if missing)
 *   3. Ensure a per-customer Shopify gift card exists (create with $0 if first grant)
 *   4. Apply giftCardCredit for the grant amount
 *   5. Insert the grant + ledger rows
 *   6. Recompute and cache the customer's total balance
 *   7. Push the four Rise-compatible Klaviyo profile properties
 */

import { z } from 'zod';
import { createSupabaseServiceClient } from './supabase/server';
import {
  findCustomerByEmail as findShopifyCustomer,
  createCustomer as createShopifyCustomer,
  giftCardCreate,
  giftCardCredit,
} from './shopify';
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

// ----- Per-row result types -----
export type RowResult =
  | { ok: true; rowIndex: number; email: string; grantId: string; amount: number; expiresOn: string; campaignName: string }
  | { ok: false; rowIndex: number; email: string; error: string; reason: 'not_in_klaviyo' | 'shopify_failed' | 'db_failed' | 'invalid' };

// ----- Helpers -----
function normalizeDate(d: string): string {
  // Accept MM/DD/YYYY or YYYY-MM-DD; return YYYY-MM-DD
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

/**
 * Find or create a campaign-level events row (grouping key = note).
 * Memoized in-memory by the caller to avoid duplicate inserts within one upload batch.
 */
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

/**
 * Ensure customer has a linked Shopify customer ID. Creates the Shopify customer if missing.
 */
async function ensureShopifyCustomer(c: LocalCustomer): Promise<string> {
  if (c.shopify_customer_id) return c.shopify_customer_id;

  let shopifyId: string;
  const found = await findShopifyCustomer(c.email);
  if (found) {
    shopifyId = found.id;
  } else {
    const created = await createShopifyCustomer({
      email: c.email,
      firstName: c.first_name ?? undefined,
      lastName: c.last_name ?? undefined,
    });
    shopifyId = created.id;
  }

  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from('customers')
    .update({ shopify_customer_id: shopifyId })
    .eq('id', c.id);
  if (error) throw new Error(`customers.shopify_customer_id update: ${error.message}`);
  return shopifyId;
}

/**
 * Ensure customer has a Shopify gift card. Creates one with $0 balance on first grant.
 * Returns the gift card ID.
 */
async function ensureGiftCard(c: LocalCustomer, shopifyCustomerId: string): Promise<{ id: string; code: string | null; last4: string | null }> {
  if (c.shopify_gift_card_id) {
    return {
      id: c.shopify_gift_card_id,
      code: c.shopify_gift_card_code,
      last4: c.shopify_gift_card_last4,
    };
  }

  const card = await giftCardCreate({
    initialValue: '0.00',
    customerId: shopifyCustomerId,
    note: `Created by Uprising for ${c.email}`,
  });

  const last4 = card.lastCharacters ?? null;
  const code = card.code ?? null;

  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from('customers')
    .update({
      shopify_gift_card_id: card.id,
      shopify_gift_card_code: code,
      shopify_gift_card_last4: last4,
    })
    .eq('id', c.id);
  if (error) throw new Error(`customers.shopify_gift_card update: ${error.message}`);

  return { id: card.id, code, last4 };
}

/**
 * Process one CSV row end-to-end.
 */
export async function processRiseRow(args: {
  rowIndex: number;
  row: RiseRow;
  eventId: string;
  uploadedBy?: string;
}): Promise<RowResult> {
  const { rowIndex, row, eventId } = args;
  const email = row.customer_email.trim().toLowerCase();
  const supabase = createSupabaseServiceClient();
  const { first: csvFirst, last: csvLast } = splitName(row.customer_name);

  let customer: LocalCustomer;
  try {
    customer = await findOrCreateCustomerByEmail(email, csvFirst, csvLast);
  } catch (e) {
    if (e instanceof NotInKlaviyoError) {
      return { ok: false, rowIndex, email, error: e.message, reason: 'not_in_klaviyo' };
    }
    return { ok: false, rowIndex, email, error: (e as Error).message, reason: 'db_failed' };
  }

  const expiresOn = normalizeDate(row.expires_on);
  const amount = Number(row.adjust_amount);

  let shopifyCustomerId: string;
  let giftCard: { id: string; code: string | null; last4: string | null };
  let creditTxnId: string | null = null;

  try {
    shopifyCustomerId = await ensureShopifyCustomer(customer);
    giftCard = await ensureGiftCard({ ...customer, shopify_customer_id: shopifyCustomerId }, shopifyCustomerId);

    const credit = await giftCardCredit(
      giftCard.id,
      amount.toFixed(2),
      `Uprising grant — event:${eventId} — ${row.note || row.reason || ''} — exp:${expiresOn}`
    );
    creditTxnId = credit.giftCardCreditTransaction?.id ?? null;
  } catch (e) {
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'grant_issue',
      entity_id: customer.id,
      ok: false,
      status_code: null,
      error_message: (e as Error).message,
      request_body: { email, amount, expiresOn, note: row.note },
    });
    return { ok: false, rowIndex, email, error: `Shopify: ${(e as Error).message}`, reason: 'shopify_failed' };
  }

  // Insert grant + ledger
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
      shopify_transaction_id: creditTxnId,
      description: row.note || row.reason || 'Issue',
    });
    if (lErr) throw new Error(lErr.message);
  } catch (e) {
    return { ok: false, rowIndex, email, error: `DB: ${(e as Error).message}`, reason: 'db_failed' };
  }

  // Recompute balance
  let newBalance = customer.total_balance_cached;
  try {
    newBalance = await recomputeBalance(customer.id);
  } catch (e) {
    // non-fatal — we already wrote the grant
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'recompute_balance',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

  // Push 4 Rise-compatible Klaviyo properties
  try {
    await upsertProfile({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_code: giftCard.code ?? customer.shopify_gift_card_code ?? undefined,
        loyalty_card_balance: newBalance,
        last_reward: amount,
        expiration_date: expiresOn,
      },
    });
  } catch (e) {
    await supabase.from('sync_log').insert({
      target: 'klaviyo',
      operation: 'profile_property_sync',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
    // non-fatal — grant is recorded; admin can re-run sync later
  }

  // Bump event aggregates (read-modify-write; fine for single-writer admin uploads)
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
    /* non-fatal — aggregates can be recomputed later from grants */
  }

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

/**
 * Group rows by note (campaign name). Each unique note becomes one event row.
 */
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
