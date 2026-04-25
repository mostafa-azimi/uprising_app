/**
 * Shopify Admin GraphQL client.
 * Docs: https://shopify.dev/docs/api/admin-graphql/latest
 *
 * This app uses Shopify Store Credit Accounts (the same feature Rise.ai uses)
 * — reloadable credit per customer with native per-credit expiration.
 *
 * Key mutations:
 *   - storeCreditAccountCredit  — adds credit (auto-creates account on first call)
 *   - storeCreditAccountDebit   — removes credit (manual adjustments only;
 *                                  expirations and redemptions are handled by
 *                                  Shopify natively)
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

// ---------- Store credit ----------
export interface StoreCreditTransactionResult {
  transactionId: string;
  accountId: string;
  newBalance: { amount: string; currencyCode: string };
  expiresAt: string | null;
}

/**
 * Add credit to a customer's store credit account. If the customer has no
 * account in this currency, Shopify auto-creates one when we pass a Customer
 * GID as the owner ID.
 *
 * @param ownerId      The Customer GID (gid://shopify/Customer/...) or
 *                     existing StoreCreditAccount GID
 * @param amount       Decimal as string, e.g. "45.00"
 * @param currencyCode 3-letter ISO code, default "USD"
 * @param expiresAt    ISO 8601 datetime, e.g. "2026-10-26T23:59:59Z" (optional)
 */
export async function storeCreditAccountCredit(args: {
  ownerId: string;
  amount: string;
  currencyCode?: string;
  expiresAt?: string;
}): Promise<StoreCreditTransactionResult> {
  const { ownerId, amount, expiresAt } = args;
  const currencyCode = args.currencyCode ?? 'USD';

  const r = await shopifyGql<{
    storeCreditAccountCredit: {
      storeCreditAccountTransaction: {
        id: string;
        amount: { amount: string; currencyCode: string };
        account: { id: string; balance: { amount: string; currencyCode: string } };
        expiresAt: string | null;
      } | null;
      userErrors: Array<{ field: string[]; message: string; code?: string }>;
    };
  }>(
    `mutation($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
       storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
         storeCreditAccountTransaction {
           id
           amount { amount currencyCode }
           account { id balance { amount currencyCode } }
           ... on StoreCreditAccountCreditTransaction { expiresAt }
         }
         userErrors { field message code }
       }
     }`,
    {
      id: ownerId,
      creditInput: {
        creditAmount: { amount, currencyCode },
        ...(expiresAt ? { expiresAt } : {}),
      },
    }
  );
  const errs = r.data?.storeCreditAccountCredit.userErrors ?? [];
  if (errs.length) {
    throw new Error('storeCreditAccountCredit: ' + errs.map((e) => `${e.message}${e.code ? ` (${e.code})` : ''}`).join('; '));
  }
  const txn = r.data?.storeCreditAccountCredit.storeCreditAccountTransaction;
  if (!txn) throw new Error('storeCreditAccountCredit returned no transaction');

  return {
    transactionId: txn.id,
    accountId: txn.account.id,
    newBalance: txn.account.balance,
    expiresAt: txn.expiresAt,
  };
}

/**
 * Debit a customer's store credit account. Used for manual adjustments only;
 * regular expirations and redemptions are handled by Shopify natively.
 */
export async function storeCreditAccountDebit(args: {
  accountId: string;
  amount: string;
  currencyCode?: string;
}): Promise<{ transactionId: string; newBalance: { amount: string; currencyCode: string } }> {
  const currencyCode = args.currencyCode ?? 'USD';
  const r = await shopifyGql<{
    storeCreditAccountDebit: {
      storeCreditAccountTransaction: {
        id: string;
        account: { id: string; balance: { amount: string; currencyCode: string } };
      } | null;
      userErrors: Array<{ field: string[]; message: string; code?: string }>;
    };
  }>(
    `mutation($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
       storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
         storeCreditAccountTransaction {
           id
           account { id balance { amount currencyCode } }
         }
         userErrors { field message code }
       }
     }`,
    {
      id: args.accountId,
      debitInput: { debitAmount: { amount: args.amount, currencyCode } },
    }
  );
  const errs = r.data?.storeCreditAccountDebit.userErrors ?? [];
  if (errs.length) {
    throw new Error('storeCreditAccountDebit: ' + errs.map((e) => `${e.message}${e.code ? ` (${e.code})` : ''}`).join('; '));
  }
  const txn = r.data?.storeCreditAccountDebit.storeCreditAccountTransaction;
  if (!txn) throw new Error('storeCreditAccountDebit returned no transaction');

  return { transactionId: txn.id, newBalance: txn.account.balance };
}

/**
 * Get a customer's first store credit account (in any currency, default to USD).
 * Returns null if the customer has no account yet.
 */
export async function getStoreCreditAccountForCustomer(customerId: string, currencyCode = 'USD'): Promise<{ id: string; balance: { amount: string; currencyCode: string } } | null> {
  const r = await shopifyGql<{
    customer: {
      storeCreditAccounts: {
        edges: Array<{ node: { id: string; balance: { amount: string; currencyCode: string } } }>;
      };
    } | null;
  }>(
    `query($id: ID!) {
       customer(id: $id) {
         storeCreditAccounts(first: 5) {
           edges { node { id balance { amount currencyCode } } }
         }
       }
     }`,
    { id: customerId }
  );
  const accounts = r.data?.customer?.storeCreditAccounts.edges ?? [];
  const match = accounts.find((e) => e.node.balance.currencyCode === currencyCode);
  return match ? match.node : null;
}
