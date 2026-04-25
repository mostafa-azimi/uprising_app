/**
 * Customer find/create logic.
 *
 * Workflow rule: a customer must already exist in Klaviyo before we can issue
 * credit. If they're not in Klaviyo, we reject the row with a clear error so
 * the admin knows to upload them to Klaviyo first.
 *
 * On first lookup we capture Klaviyo's custom properties so we can reuse an
 * existing `loyalty_card_code` (matching Rise's identifier) on cutover.
 */

import { findProfileByEmail, type KlaviyoProfileLookup } from './klaviyo';
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
  shopify_store_credit_account_id: string | null;
  loyalty_card_code: string | null;
  klaviyo_profile_id: string | null;
  total_balance_cached: number;
}

/**
 * Result of finding or creating a customer. Includes the Klaviyo profile we
 * looked up (if any) so the caller can read existing custom properties.
 */
export interface CustomerLookupResult {
  customer: LocalCustomer;
  klaviyo: KlaviyoProfileLookup;
}

export async function findOrCreateCustomerByEmail(
  email: string,
  csvFirstName?: string,
  csvLastName?: string
): Promise<CustomerLookupResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const supabase = createSupabaseServiceClient();

  // Always look up Klaviyo first so we can pull custom properties (existing
  // loyalty_card_code, etc.) and gate on Klaviyo presence.
  const klaviyo = await findProfileByEmail(normalizedEmail);
  if (!klaviyo) throw new NotInKlaviyoError(normalizedEmail);

  // Look up locally
  const { data: existing, error: selErr } = await supabase
    .from('customers')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (selErr) throw new Error(`DB lookup failed for ${normalizedEmail}: ${selErr.message}`);
  if (existing) return { customer: existing as LocalCustomer, klaviyo };

  // Not local — create using Klaviyo data, falling back to CSV-supplied names
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
    if (insErr.code === '23505') {
      const { data: again } = await supabase
        .from('customers')
        .select('*')
        .eq('email', normalizedEmail)
        .single();
      if (again) return { customer: again as LocalCustomer, klaviyo };
    }
    throw new Error(`DB insert failed for ${normalizedEmail}: ${insErr.message}`);
  }
  return { customer: created as LocalCustomer, klaviyo };
}

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
