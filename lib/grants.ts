/**
 * Grant processing — issue store credit to one customer.
 *
 * For each row:
 *   1. Find or create local customer (gates on Klaviyo presence)
 *   2. Reuse or generate the synthetic 16-char hex loyalty_card_code (Rise format)
 *   3. Ensure a Shopify customer exists (link by email, create if missing)
 *   4. Call storeCreditAccountCredit with expiresAt — Shopify auto-creates
 *      the store credit account on first call, and natively expires individual
 *      credit transactions on their expiresAt date
 *   5. Insert the grant + ledger rows
 *   6. Recompute and cache the customer's total balance
 *   7. Push the four Rise-compatible Klaviyo profile properties
 */

import { randomBytes } from 'crypto';
import { z } from 'zod';
import { createSupabaseServiceClient } from './supabase/server';
import {
  findCustomerByEmail as findShopifyCustomer,
  createCustomer as createShopifyCustomer,
  storeCreditAccountCredit,
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

export type RowResult =
  | { ok: true; rowIndex: number; email: string; grantId: string; amount: number; expiresOn: string; campaignName: string }
  | { ok: false; rowIndex: number; email: string; error: string; reason: 'not_in_klaviyo' | 'shopify_failed' | 'db_failed' | 'invalid' };

// ----- Helpers -----
function normalizeDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [m, day, y] = d.split('/');
  return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** YYYY-MM-DD → ISO8601 datetime at end-of-day UTC (gives the customer the full day). */
function toEndOfDayIso(date: string): string {
  return `${date}T23:59:59Z`;
}

function splitName(name: string | undefined): { first?: string; last?: string } {
  if (!name) return {};
  const trimmed = name.trim();
  if (!trimmed) return {};
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Generate a 16-char lowercase hex loyalty card code matching Rise's format. */
function generateLoyaltyCardCode(): string {
  return randomBytes(8).toString('hex');
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

/**
 * Ensure customer has a linked Shopify customer ID. Creates the Shopify
 * customer if none exists yet.
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
 * Resolve the loyalty_card_code for this customer:
 *   1. If we already have one in our DB, reuse it
 *   2. Else if Klaviyo profile already has one (cutover from Rise), reuse it
 *   3. Else generate a new 16-char hex code and persist
 */
async function resolveLoyaltyCardCode(
  customer: LocalCustomer,
  klaviyoProperties: Record<string, unknown>
): Promise<string> {
  if (customer.loyalty_card_code) return customer.loyalty_card_code;

  const fromKlaviyo = typeof klaviyoProperties.loyalty_card_code === 'string'
    ? (klaviyoProperties.loyalty_card_code as string).trim()
    : '';
  const code = fromKlaviyo || generateLoyaltyCardCode();

  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from('customers')
    .update({ loyalty_card_code: code })
    .eq('id', customer.id);
  if (error) throw new Error(`loyalty_card_code update: ${error.message}`);
  return code;
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

  // --- 1. Find or create local customer (gates on Klaviyo) ---
  let lookup: { customer: LocalCustomer; klaviyo: { id: string; properties: Record<string, unknown> } };
  try {
    lookup = await findOrCreateCustomerByEmail(email, csvFirst, csvLast);
  } catch (e) {
    if (e instanceof NotInKlaviyoError) {
      return { ok: false, rowIndex, email, error: e.message, reason: 'not_in_klaviyo' };
    }
    return { ok: false, rowIndex, email, error: (e as Error).message, reason: 'db_failed' };
  }
  let customer = lookup.customer;

  // --- 2. Resolve loyalty_card_code (reuse Klaviyo's if present) ---
  let loyaltyCardCode: string;
  try {
    loyaltyCardCode = await resolveLoyaltyCardCode(customer, lookup.klaviyo.properties);
    customer = { ...customer, loyalty_card_code: loyaltyCardCode };
  } catch (e) {
    return { ok: false, rowIndex, email, error: (e as Error).message, reason: 'db_failed' };
  }

  const expiresOn = normalizeDate(row.expires_on);
  const expiresAtIso = toEndOfDayIso(expiresOn);
  const amount = Number(row.adjust_amount);

  // --- 3 & 4. Ensure Shopify customer + apply credit ---
  let shopifyCustomerId: string;
  let creditResult;
  try {
    shopifyCustomerId = await ensureShopifyCustomer(customer);
    customer = { ...customer, shopify_customer_id: shopifyCustomerId };

    creditResult = await storeCreditAccountCredit({
      ownerId: shopifyCustomerId,
      amount: amount.toFixed(2),
      currencyCode: 'USD',
      expiresAt: expiresAtIso,
    });

    // Persist the store credit account ID (same on every call for this customer)
    if (customer.shopify_store_credit_account_id !== creditResult.accountId) {
      const { error } = await supabase
        .from('customers')
        .update({ shopify_store_credit_account_id: creditResult.accountId })
        .eq('id', customer.id);
      if (error) throw new Error(`customers.store_credit_account_id update: ${error.message}`);
    }
  } catch (e) {
    const errMsg = (e as Error).message;
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'storeCreditAccountCredit',
      entity_id: customer.id,
      ok: false,
      error_message: errMsg,
      request_body: {
        email,
        amount,
        expiresAt: expiresAtIso,
        shopify_customer_id: customer.shopify_customer_id,
        existing_account_id: customer.shopify_store_credit_account_id,
      },
      response_body: { stack: ((e as Error).stack ?? '').slice(0, 2000) },
    });
    return { ok: false, rowIndex, email, error: `Shopify: ${errMsg}`, reason: 'shopify_failed' };
  }

  // --- 5. Insert grant + ledger ---
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
      shopify_transaction_id: creditResult.transactionId,
      description: row.note || row.reason || 'Issue',
    });
    if (lErr) throw new Error(lErr.message);
  } catch (e) {
    return { ok: false, rowIndex, email, error: `DB: ${(e as Error).message}`, reason: 'db_failed' };
  }

  // --- 6. Recompute cached balance ---
  let newBalance = customer.total_balance_cached;
  try {
    newBalance = await recomputeBalance(customer.id);
  } catch (e) {
    await supabase.from('sync_log').insert({
      target: 'shopify',
      operation: 'recompute_balance',
      entity_id: customer.id,
      ok: false,
      error_message: (e as Error).message,
    });
  }

  // --- 7. Push 4 Rise-compatible Klaviyo properties ---
  try {
    await upsertProfile({
      email: customer.email,
      first_name: customer.first_name ?? undefined,
      last_name: customer.last_name ?? undefined,
      properties: {
        loyalty_card_code: loyaltyCardCode,
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
  }

  // --- Bump event aggregates (read-modify-write) ---
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
