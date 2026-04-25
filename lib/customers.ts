/**
 * Customer find/create logic.
 *
 * Workflow rule: a customer must already exist in Klaviyo before we can issue
 * credit. If they're not in Klaviyo, we reject the row with a clear error so
 * the admin knows to upload them to Klaviyo first.
 *
 * Three outcomes per email:
 *   1. Found in our DB and in Klaviyo            → return existing customer
 *   2. Found in Klaviyo, not in our DB           → create local record from Klaviyo data
 *   3. Not found in Klaviyo                      → throw NotInKlaviyoError
 */

import { findProfileByEmail } from './klaviyo';
import { createSupabaseServiceClient } from './supabase/server';

export class NotInKlaviyoError extends Error {
  constructor(email: string) {
    super(`Customer ${email} not found in Klaviyo. Upload to Klaviyo first.`);
    this.name = 'NotInKlaviyoError';
  }
}

export interface LocalCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  shopify_customer_id: string | null;
  shopify_gift_card_id: string | null;
  shopify_gift_card_code: string | null;
  shopify_gift_card_last4: string | null;
  klaviyo_profile_id: string | null;
  total_balance_cached: number;
}

/**
 * Find the customer in our DB by email. If absent, look up in Klaviyo;
 * if Klaviyo has them, create a local record. If Klaviyo doesn't have them, throw.
 *
 * Caller (csv processor) catches NotInKlaviyoError and reports the row as failed.
 */
export async function findOrCreateCustomerByEmail(
  email: string,
  csvFirstName?: string,
  csvLastName?: string
): Promise<LocalCustomer> {
  const normalizedEmail = email.trim().toLowerCase();
  const supabase = createSupabaseServiceClient();

  // Look up locally first
  const { data: existing, error: selErr } = await supabase
    .from('customers')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (selErr) throw new Error(`DB lookup failed for ${normalizedEmail}: ${selErr.message}`);
  if (existing) return existing as LocalCustomer;

  // Not local — must exist in Klaviyo
  const klaviyo = await findProfileByEmail(normalizedEmail);
  if (!klaviyo) throw new NotInKlaviyoError(normalizedEmail);

  // Create local record using Klaviyo data, falling back to CSV-supplied names
  const firstName = klaviyo.first_name || csvFirstName || null;
  const lastName = klaviyo.last_name || csvLastName || null;

  const { data: created, error: insErr } = await supabase
    .from('customers')
    .insert({
      email: normalizedEmail,
      first_name: firstName,
      last_name: lastName,
      klaviyo_profile_id: klaviyo.id,
    })
    .select('*')
    .single();

  if (insErr) {
    // Race: another row in the same upload created this customer concurrently. Re-fetch.
    if (insErr.code === '23505') {
      const { data: again } = await supabase
        .from('customers')
        .select('*')
        .eq('email', normalizedEmail)
        .single();
      if (again) return again as LocalCustomer;
    }
    throw new Error(`DB insert failed for ${normalizedEmail}: ${insErr.message}`);
  }
  return created as LocalCustomer;
}

/**
 * Update the cached balance on a customer (sum of remaining_amount across active grants).
 */
export async function recomputeBalance(customerId: string): Promise<number> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from('grants')
    .select('remaining_amount')
    .eq('customer_id', customerId)
    .eq('status', 'active');
  if (error) throw new Error(`recomputeBalance: ${error.message}`);

  const total = (data ?? []).reduce((acc, r) => acc + Number(r.remaining_amount), 0);

  const { error: updErr } = await supabase
    .from('customers')
    .update({ total_balance_cached: total })
    .eq('id', customerId);
  if (updErr) throw new Error(`recomputeBalance update: ${updErr.message}`);

  return Math.round(total * 100) / 100;
}
