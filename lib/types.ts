/**
 * Shared types for the Uprising app.
 */

export type GrantStatus = 'active' | 'expired' | 'fully_redeemed';

export type LedgerType = 'issue' | 'redeem' | 'expire' | 'adjust';

export interface RiseCsvRow {
  code: string;
  adjust_amount: number;
  expires_on: string; // YYYY-MM-DD
  customer_name?: string;
  customer_email: string;
  reason?: string;
  note?: string;
}

export interface ShopifyStoreCreditAccount {
  id: string;          // gid://shopify/StoreCreditAccount/...
  balance: { amount: string; currencyCode: string };
}

export interface KlaviyoProfile {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
}
