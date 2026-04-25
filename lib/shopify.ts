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
export async function giftCardCredit(id: string, amount: string, note?: string, currencyCode = 'USD'): Promise<GiftCardCreditResult> {
  // 2025-04+: input shape changed to creditAmount: MoneyInput, and giftCard
  // moved under the transaction.
  const r = await shopifyGql<{
    giftCardCredit: {
      giftCardCreditTransaction: {
        id: string;
        amount: { amount: string };
        giftCard: { id: string; balance: { amount: string; currencyCode: string } } | null;
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation($id: ID!, $creditInput: GiftCardCreditInput!) {
       giftCardCredit(id: $id, creditInput: $creditInput) {
         giftCardCreditTransaction {
           id
           amount { amount }
           giftCard { id balance { amount currencyCode } }
         }
         userErrors { field message }
       }
     }`,
    {
      id,
      creditInput: {
        creditAmount: { amount, currencyCode },
        note,
      },
    }
  );
  const errs = r.data?.giftCardCredit.userErrors ?? [];
  if (errs.length) throw new Error('giftCardCredit: ' + errs.map((e) => e.message).join('; '));
  const txn = r.data?.giftCardCredit.giftCardCreditTransaction;
  if (!txn?.giftCard) throw new Error('giftCardCredit returned no transaction or gift card');
  return {
    transactionId: txn.id,
    newBalance: txn.giftCard.balance,
  };
}

/** Reduce an existing gift card balance. Used for expirations and manual debits. */
export async function giftCardDebit(id: string, amount: string, note?: string, currencyCode = 'USD'): Promise<GiftCardCreditResult> {
  const r = await shopifyGql<{
    giftCardDebit: {
      giftCardDebitTransaction: {
        id: string;
        amount: { amount: string };
        giftCard: { id: string; balance: { amount: string; currencyCode: string } } | null;
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation($id: ID!, $debitInput: GiftCardDebitInput!) {
       giftCardDebit(id: $id, debitInput: $debitInput) {
         giftCardDebitTransaction {
           id
           amount { amount }
           giftCard { id balance { amount currencyCode } }
         }
         userErrors { field message }
       }
     }`,
    {
      id,
      debitInput: {
        debitAmount: { amount, currencyCode },
        note,
      },
    }
  );
  const errs = r.data?.giftCardDebit.userErrors ?? [];
  if (errs.length) throw new Error('giftCardDebit: ' + errs.map((e) => e.message).join('; '));
  const txn = r.data?.giftCardDebit.giftCardDebitTransaction;
  if (!txn?.giftCard) throw new Error('giftCardDebit returned no transaction or gift card');
  return {
    transactionId: txn.id,
    newBalance: txn.giftCard.balance,
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
 * Paginate through ALL gift cards in the Shopify store. Used for the bulk-link
 * tool that matches existing Rise gift cards to our customers by last 4 of code.
 *
 * Returns an array of cards with their id, lastCharacters, enabled flag, and balance.
 * Ordered newest-first by Shopify default. Stops when hasNextPage is false.
 *
 * For a store with N gift cards, this issues ceil(N/250) GraphQL queries.
 */
export interface PaginatedGiftCardNode {
  id: string;
  lastCharacters: string | null;
  maskedCode: string | null;
  enabled: boolean;
  balance: { amount: string; currencyCode: string };
  expiresOn: string | null;
}

interface PaginatedGiftCardsResponse {
  giftCards: {
    edges: Array<{ cursor: string; node: PaginatedGiftCardNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function paginateAllGiftCards(maxPages = 200): Promise<PaginatedGiftCardNode[]> {
  const all: PaginatedGiftCardNode[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (pages < maxPages) {
    pages++;
    const r: ShopifyGqlResult<PaginatedGiftCardsResponse> = await shopifyGql<PaginatedGiftCardsResponse>(
      `query($cursor: String) {
         giftCards(first: 250, after: $cursor) {
           edges {
             cursor
             node {
               id
               lastCharacters
               maskedCode
               enabled
               balance { amount currencyCode }
               expiresOn
             }
           }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { cursor }
    );

    const edges = r.data?.giftCards.edges ?? [];
    all.push(...edges.map((e) => e.node));

    const info = r.data?.giftCards.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    cursor = info.endCursor;
  }

  return all;
}

/**
 * Search Shopify for gift cards by the last 4 characters of the code.
 *
 * Tries multiple search-syntax variants for resilience across API versions
 * (older versions accept `code:`, newer accept `last_characters:`).
 */
export interface GiftCardSearchNode {
  id: string;
  maskedCode: string | null;
  lastCharacters: string | null;
  balance: { amount: string; currencyCode: string };
  enabled: boolean;
}

interface GiftCardSearchResponse {
  giftCards: { edges: Array<{ node: GiftCardSearchNode }> };
}

export async function findGiftCardsByLast4(last4: string): Promise<GiftCardSearchNode[]> {
  const tries = [
    `last_characters:${last4}`,
    `code:${last4}`,
    `last_characters:'${last4}'`,
  ];

  const seen = new Map<string, GiftCardSearchNode>();
  for (const q of tries) {
    try {
      const r: ShopifyGqlResult<GiftCardSearchResponse> = await shopifyGql<GiftCardSearchResponse>(
        `query($q: String!) {
           giftCards(first: 50, query: $q) {
             edges { node { id maskedCode lastCharacters balance { amount currencyCode } enabled } }
           }
         }`,
        { q }
      );
      for (const e of r.data?.giftCards.edges ?? []) {
        seen.set(e.node.id, e.node);
      }
      if (seen.size > 0) break; // first variant that returns something wins
    } catch {
      // Try next syntax — some accounts/versions reject specific filters
    }
  }

  // As a last resort: empty query (returns most-recent cards) and filter client-side
  if (seen.size === 0) {
    const r: ShopifyGqlResult<GiftCardSearchResponse> = await shopifyGql<GiftCardSearchResponse>(
      `query { giftCards(first: 250) { edges { node { id maskedCode lastCharacters balance { amount currencyCode } enabled } } } }`
    );
    for (const e of r.data?.giftCards.edges ?? []) {
      if (e.node.lastCharacters === last4) seen.set(e.node.id, e.node);
    }
  }

  return Array.from(seen.values());
}
