/**
 * Shopify Admin GraphQL client.
 * Docs: https://shopify.dev/docs/api/admin-graphql/latest
 *
 * Rise.ai uses orphan Shopify Gift Cards (no customer link, no notification email).
 * The gift card code returned at creation IS the loyalty_card_code we push to Klaviyo.
 *
 * 2025-04+ schema notes:
 *   - GiftCard.code is removed; the full code is on the giftCardCreate payload
 *     as `giftCardCode` (only available at creation).
 *   - GiftCard.customerId is removed; use `customer { id }`.
 */

interface ShopifyConfig {
  shop: string;
  token: string;
  apiVersion: string;
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
  extensions?: { cost?: unknown };
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

// ---------- Shop info ----------
export async function getShopInfo() {
  const r = await shopifyGql<{ shop: { name: string; primaryDomain: { url: string }; currencyCode: string } }>(
    `{ shop { name primaryDomain { url } currencyCode } }`
  );
  return r.data!.shop;
}

// ---------- Customer lookup (used by /test-connections only — gift cards stay orphan) ----------
export async function findCustomerByEmail(email: string): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null } | null> {
  const r = await shopifyGql<{ customers: { edges: Array<{ node: { id: string; email: string; firstName: string | null; lastName: string | null } }> } }>(
    `query($q: String!) {
       customers(first: 1, query: $q) {
         edges { node { id email firstName lastName } }
       }
     }`,
    { q: `email:${email}` }
  );
  return r.data?.customers.edges[0]?.node ?? null;
}

// ---------- Gift cards (orphan: no customer link, no notification email) ----------
export interface OrphanGiftCard {
  id: string;
  code: string | null;          // full code, only present at creation
  maskedCode: string | null;
  lastCharacters: string | null;
  balance: { amount: string; currencyCode: string };
}

/**
 * Create an orphan gift card (no customer link, no notification email).
 * Initial value MUST be > 0 — Shopify rejects $0 cards.
 */
export async function giftCardCreate(input: {
  initialValue: string;     // decimal as string, e.g. "45.00"
  expiresOn?: string;       // YYYY-MM-DD (optional; per-grant expiration is in our DB)
  note?: string;
}): Promise<OrphanGiftCard> {
  const r = await shopifyGql<{
    giftCardCreate: {
      giftCardCode: string | null;
      giftCard: {
        id: string;
        maskedCode: string | null;
        lastCharacters: string | null;
        balance: { amount: string; currencyCode: string };
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
    code: r.data!.giftCardCreate.giftCardCode ?? null,
    maskedCode: gc.maskedCode,
    lastCharacters: gc.lastCharacters,
    balance: gc.balance,
  };
}

export interface GiftCardCreditResult {
  transactionId: string | null;
  newBalance: { amount: string; currencyCode: string };
}

/** Add balance to an existing gift card. Used on every grant after the first. */
export async function giftCardCredit(id: string, amount: string, note?: string): Promise<GiftCardCreditResult> {
  const r = await shopifyGql<{
    giftCardCredit: {
      giftCardCreditTransaction: { id: string; amount: { amount: string } } | null;
      giftCard: { id: string; balance: { amount: string; currencyCode: string } } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation($id: ID!, $creditInput: GiftCardCreditInput!) {
       giftCardCredit(id: $id, creditInput: $creditInput) {
         giftCardCreditTransaction { id amount { amount } }
         giftCard { id balance { amount currencyCode } }
         userErrors { field message }
       }
     }`,
    { id, creditInput: { amount, note } }
  );
  const errs = r.data?.giftCardCredit.userErrors ?? [];
  if (errs.length) throw new Error('giftCardCredit: ' + errs.map((e) => e.message).join('; '));
  return {
    transactionId: r.data?.giftCardCredit.giftCardCreditTransaction?.id ?? null,
    newBalance: r.data!.giftCardCredit.giftCard!.balance,
  };
}

/** Reduce an existing gift card balance. Used for expirations and manual debits. */
export async function giftCardDebit(id: string, amount: string, note?: string): Promise<GiftCardCreditResult> {
  const r = await shopifyGql<{
    giftCardDebit: {
      giftCardDebitTransaction: { id: string; amount: { amount: string } } | null;
      giftCard: { id: string; balance: { amount: string; currencyCode: string } } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation($id: ID!, $debitInput: GiftCardDebitInput!) {
       giftCardDebit(id: $id, debitInput: $debitInput) {
         giftCardDebitTransaction { id amount { amount } }
         giftCard { id balance { amount currencyCode } }
         userErrors { field message }
       }
     }`,
    { id, debitInput: { amount, note } }
  );
  const errs = r.data?.giftCardDebit.userErrors ?? [];
  if (errs.length) throw new Error('giftCardDebit: ' + errs.map((e) => e.message).join('; '));
  return {
    transactionId: r.data?.giftCardDebit.giftCardDebitTransaction?.id ?? null,
    newBalance: r.data!.giftCardDebit.giftCard!.balance,
  };
}

/** Look up a gift card by its Shopify GID. Used for reconciliation and seeded customers. */
export async function getGiftCard(id: string) {
  const r = await shopifyGql<{
    giftCard: {
      id: string;
      maskedCode: string | null;
      lastCharacters: string | null;
      balance: { amount: string; currencyCode: string };
      enabled: boolean;
      expiresOn: string | null;
    } | null;
  }>(
    `query($id: ID!) {
       giftCard(id: $id) {
         id maskedCode lastCharacters balance { amount currencyCode } enabled expiresOn
       }
     }`,
    { id }
  );
  return r.data?.giftCard ?? null;
}

/**
 * Search Shopify for a gift card by the last 4 characters of its code.
 * Used post-seed to find the gift card ID for a customer migrated from Rise
 * (we have the loyalty_card_code from Klaviyo, just need to find the ID).
 *
 * Returns all matching gift cards. The caller verifies which one matches by
 * comparing `lastCharacters` and balance.
 */
export async function findGiftCardsByLast4(last4: string) {
  const r = await shopifyGql<{
    giftCards: { edges: Array<{ node: { id: string; maskedCode: string | null; lastCharacters: string | null; balance: { amount: string; currencyCode: string }; enabled: boolean } }> };
  }>(
    `query($q: String!) {
       giftCards(first: 20, query: $q) {
         edges { node { id maskedCode lastCharacters balance { amount currencyCode } enabled } }
       }
     }`,
    { q: `code:${last4}` }
  );
  return (r.data?.giftCards.edges ?? []).map((e) => e.node);
}
