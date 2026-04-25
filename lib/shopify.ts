/**
 * Shopify Admin GraphQL client.
 * Docs: https://shopify.dev/docs/api/admin-graphql/latest
 */

import type { ShopifyGiftCard } from './types';

interface ShopifyConfig {
  shop: string;        // store-domain.myshopify.com
  token: string;       // shpat_...
  apiVersion: string;  // e.g. 2025-10
}

function cfg(): ShopifyConfig {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
  if (!shop || !token) throw new Error('Shopify env vars missing: SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_TOKEN');
  return { shop, token, apiVersion };
}

export interface ShopifyGqlResult<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
}

export async function shopifyGql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<ShopifyGqlResult<T>> {
  const { shop, token, apiVersion } = cfg();
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${res.status}: ${text.slice(0, 800)}`);
  }
  const json = (await res.json()) as ShopifyGqlResult<T>;
  // Surface top-level GraphQL errors (auth, scope, syntax, missing fields)
  if (json.errors?.length) {
    throw new Error(
      'Shopify GraphQL: ' +
        json.errors
          .map((e) => `${e.message}${e.extensions ? ' [' + JSON.stringify(e.extensions) + ']' : ''}`)
          .join('; ')
    );
  }
  return json;
}

// ---------- Shop info (for connectivity test) ----------
export async function getShopInfo() {
  const r = await shopifyGql<{ shop: { name: string; primaryDomain: { url: string }; currencyCode: string } }>(
    `{ shop { name primaryDomain { url } currencyCode } }`
  );
  if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.data!.shop;
}

// ---------- Customer lookup / create ----------
export async function findCustomerByEmail(email: string): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null } | null> {
  const r = await shopifyGql<{ customers: { edges: Array<{ node: { id: string; email: string; firstName: string | null; lastName: string | null } }> } }>(
    `query($q: String!) {
       customers(first: 1, query: $q) {
         edges { node { id email firstName lastName } }
       }
     }`,
    { q: `email:${email}` }
  );
  if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.data?.customers.edges[0]?.node ?? null;
}

export async function createCustomer(input: { email: string; firstName?: string; lastName?: string }): Promise<{ id: string }> {
  const r = await shopifyGql<{ customerCreate: { customer: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    `mutation($input: CustomerInput!) {
       customerCreate(input: $input) {
         customer { id }
         userErrors { field message }
       }
     }`,
    { input }
  );
  const errs = r.data?.customerCreate.userErrors ?? [];
  if (errs.length) throw new Error('customerCreate: ' + errs.map((e) => e.message).join('; '));
  if (!r.data?.customerCreate.customer) throw new Error('customerCreate returned no customer');
  return r.data.customerCreate.customer;
}

// ---------- Gift cards ----------
export async function giftCardCreate(input: {
  initialValue: string;       // decimal as string e.g. "0.00"
  customerId?: string;        // gid://shopify/Customer/...
  expiresOn?: string;         // YYYY-MM-DD
  note?: string;
}): Promise<ShopifyGiftCard> {
  // 2025-04+: full code is on payload (giftCardCode); customerId moved to customer.id
  const r = await shopifyGql<{
    giftCardCreate: {
      giftCardCode: string | null;
      giftCard: {
        id: string;
        maskedCode?: string;
        lastCharacters?: string;
        balance: { amount: string; currencyCode: string };
        customer: { id: string } | null;
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation($input: GiftCardCreateInput!) {
       giftCardCreate(input: $input) {
         giftCardCode
         giftCard {
           id
           maskedCode
           lastCharacters
           balance { amount currencyCode }
           customer { id }
         }
         userErrors { field message }
       }
     }`,
    { input }
  );
  const errs = r.data?.giftCardCreate.userErrors ?? [];
  if (errs.length) throw new Error('giftCardCreate: ' + errs.map((e) => e.message).join('; '));
  const gc = r.data?.giftCardCreate.giftCard;
  if (!gc) throw new Error('giftCardCreate returned no card');
  return {
    id: gc.id,
    code: r.data!.giftCardCreate.giftCardCode ?? undefined,
    maskedCode: gc.maskedCode,
    lastCharacters: gc.lastCharacters,
    balance: gc.balance,
    customerId: gc.customer?.id ?? null,
  };
}

export async function giftCardCredit(id: string, amount: string, note?: string) {
  const r = await shopifyGql<{ giftCardCredit: { giftCardCreditTransaction: { id: string; amount: { amount: string } } | null; giftCard: { id: string; balance: { amount: string } } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    `mutation($id: ID!, $creditInput: GiftCardCreditInput!) {
       giftCardCredit(id: $id, creditInput: $creditInput) {
         giftCardCreditTransaction { id amount { amount } }
         giftCard { id balance { amount } }
         userErrors { field message }
       }
     }`,
    { id, creditInput: { amount, note } }
  );
  const errs = r.data?.giftCardCredit.userErrors ?? [];
  if (errs.length) throw new Error('giftCardCredit: ' + errs.map((e) => e.message).join('; '));
  return r.data!.giftCardCredit;
}

export async function giftCardDebit(id: string, amount: string, note?: string) {
  const r = await shopifyGql<{ giftCardDebit: { giftCardDebitTransaction: { id: string; amount: { amount: string } } | null; giftCard: { id: string; balance: { amount: string } } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    `mutation($id: ID!, $debitInput: GiftCardDebitInput!) {
       giftCardDebit(id: $id, debitInput: $debitInput) {
         giftCardDebitTransaction { id amount { amount } }
         giftCard { id balance { amount } }
         userErrors { field message }
       }
     }`,
    { id, debitInput: { amount, note } }
  );
  const errs = r.data?.giftCardDebit.userErrors ?? [];
  if (errs.length) throw new Error('giftCardDebit: ' + errs.map((e) => e.message).join('; '));
  return r.data!.giftCardDebit;
}

export async function getGiftCard(id: string) {
  const r = await shopifyGql<{
    giftCard: {
      id: string;
      balance: { amount: string; currencyCode: string };
      enabled: boolean;
      expiresOn: string | null;
      customer: { id: string } | null;
    } | null;
  }>(
    `query($id: ID!) {
       giftCard(id: $id) {
         id
         balance { amount currencyCode }
         enabled
         expiresOn
         customer { id }
       }
     }`,
    { id }
  );
  const gc = r.data?.giftCard;
  if (!gc) return null;
  return {
    id: gc.id,
    balance: gc.balance,
    enabled: gc.enabled,
    expiresOn: gc.expiresOn,
    customerId: gc.customer?.id ?? null,
  };
}
