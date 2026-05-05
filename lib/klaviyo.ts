/**
 * Klaviyo REST client.
 * Docs: https://developers.klaviyo.com
 *
 * The four Rise-compatible profile properties we maintain:
 *   - loyalty_card_code
 *   - loyalty_card_balance
 *   - last_reward
 *   - expiration_date
 */

interface KlaviyoConfig {
  apiKey: string;     // pk_...
  revision: string;   // e.g. 2025-01-15
}

function cfg(): KlaviyoConfig {
  const apiKey = process.env.KLAVIYO_API_KEY;
  const revision = process.env.KLAVIYO_REVISION || '2025-01-15';
  if (!apiKey) throw new Error('Klaviyo env var missing: KLAVIYO_API_KEY');
  return { apiKey, revision };
}

function headers() {
  const { apiKey, revision } = cfg();
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

const BASE = 'https://a.klaviyo.com/api';

export interface RiseProfileProps {
  loyalty_card_code?: string;
  loyalty_card_balance?: number;
  last_reward?: number;
  expiration_date?: string; // YYYY-MM-DD
}

// ---------- Connectivity test ----------
export async function getKlaviyoAccount(): Promise<{ id: string; contact_email?: string }> {
  const res = await fetch(`${BASE}/accounts/`, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Klaviyo accounts ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data: Array<{ id: string; attributes?: { contact_information?: { default_sender_email?: string } } }> };
  const acc = json.data[0];
  return { id: acc.id, contact_email: acc.attributes?.contact_information?.default_sender_email };
}

// ---------- Profile lookup / upsert ----------
export interface KlaviyoProfileLookup {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  properties: Record<string, unknown>;
}

/**
 * Fetch one page of profiles. Used by the seed/migration importer.
 * Optionally scoped to a single Klaviyo list.
 *
 * Klaviyo paginates with opaque cursors in `links.next` URLs.
 *
 * @param cursor `links.next` URL from the previous page, or null for first page
 * @param listId optional Klaviyo list ID to scope the query
 * @param pageSize 1–100, default 100
 */
export async function listProfilesPage(args: {
  cursor?: string | null;
  listId?: string;
  pageSize?: number;
}): Promise<{
  profiles: KlaviyoProfileLookup[];
  nextCursor: string | null;
}> {
  const pageSize = Math.min(args.pageSize ?? 100, 100);

  let url: URL;
  if (args.cursor) {
    // Klaviyo returns the next URL fully formed
    url = new URL(args.cursor);
  } else if (args.listId) {
    url = new URL(`${BASE}/lists/${args.listId}/profiles/`);
    url.searchParams.set('page[size]', String(pageSize));
    url.searchParams.set('fields[profile]', 'email,first_name,last_name,properties');
  } else {
    url = new URL(`${BASE}/profiles/`);
    url.searchParams.set('page[size]', String(pageSize));
    url.searchParams.set('fields[profile]', 'email,first_name,last_name,properties');
  }

  const res = await fetch(url, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Klaviyo listProfilesPage ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as {
    data: Array<{
      id: string;
      attributes: {
        email: string;
        first_name: string | null;
        last_name: string | null;
        properties?: Record<string, unknown>;
      };
    }>;
    links?: { next?: string | null };
  };

  return {
    profiles: json.data.map((p) => ({
      id: p.id,
      email: p.attributes.email,
      first_name: p.attributes.first_name,
      last_name: p.attributes.last_name,
      properties: p.attributes.properties ?? {},
    })),
    nextCursor: json.links?.next ?? null,
  };
}

export async function findProfileByEmail(email: string): Promise<KlaviyoProfileLookup | null> {
  const url = new URL(`${BASE}/profiles/`);
  url.searchParams.set('filter', `equals(email,"${email}")`);
  url.searchParams.set('fields[profile]', 'email,first_name,last_name,properties');

  const res = await fetch(url, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Klaviyo profiles ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    data: Array<{
      id: string;
      attributes: {
        email: string;
        first_name: string | null;
        last_name: string | null;
        properties?: Record<string, unknown>;
      };
    }>;
  };
  const p = json.data[0];
  if (!p) return null;
  return {
    id: p.id,
    email: p.attributes.email,
    first_name: p.attributes.first_name,
    last_name: p.attributes.last_name,
    properties: p.attributes.properties ?? {},
  };
}

export async function upsertProfile(args: {
  email: string;
  first_name?: string;
  last_name?: string;
  properties?: RiseProfileProps & Record<string, unknown>;
}): Promise<{ id: string }> {
  const body = {
    data: {
      type: 'profile',
      attributes: {
        email: args.email,
        first_name: args.first_name,
        last_name: args.last_name,
        properties: args.properties,
      },
    },
  };

  // ---- DIAGNOSTIC: instrument the two Klaviyo calls so we can see in Vercel
  // logs which one is slow (POST create vs PATCH update) and capture rate
  // limit headers. No behavior change. Remove after the slowness root cause
  // is identified.
  const tStart = Date.now();

  const createRes = await fetch(`${BASE}/profiles/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const tCreate = Date.now() - tStart;

  // Pull Klaviyo's rate limit headers if present
  const rateLimitInfo = {
    limit_burst: createRes.headers.get('x-ratelimit-limit-burst') ?? null,
    remaining_burst: createRes.headers.get('x-ratelimit-remaining-burst') ?? null,
    limit_steady: createRes.headers.get('x-ratelimit-limit-steady') ?? null,
    remaining_steady: createRes.headers.get('x-ratelimit-remaining-steady') ?? null,
    retry_after: createRes.headers.get('retry-after') ?? null,
  };

  if (createRes.status === 201 || createRes.status === 200) {
    const json = (await createRes.json()) as { data: { id: string } };
    console.log(JSON.stringify({
      klaviyo_timing: 'upsertProfile',
      path: 'create',
      status: createRes.status,
      ms_create: tCreate,
      ms_total: Date.now() - tStart,
      email_hash: args.email.length, // length only; don't log PII
      ratelimit: rateLimitInfo,
    }));
    return { id: json.data.id };
  }

  // 409 = already exists. Patch by ID.
  if (createRes.status === 409) {
    const conflict = (await createRes.json()) as { errors?: Array<{ meta?: { duplicate_profile_id?: string } }> };
    const id = conflict.errors?.[0]?.meta?.duplicate_profile_id;
    if (!id) throw new Error('Klaviyo 409 without duplicate_profile_id');

    const patchBody = { data: { type: 'profile', id, attributes: body.data.attributes } };
    const tPatchStart = Date.now();
    const patchRes = await fetch(`${BASE}/profiles/${id}/`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(patchBody),
      cache: 'no-store',
    });
    const tPatch = Date.now() - tPatchStart;
    const patchRateLimit = {
      limit_burst: patchRes.headers.get('x-ratelimit-limit-burst') ?? null,
      remaining_burst: patchRes.headers.get('x-ratelimit-remaining-burst') ?? null,
      limit_steady: patchRes.headers.get('x-ratelimit-limit-steady') ?? null,
      remaining_steady: patchRes.headers.get('x-ratelimit-remaining-steady') ?? null,
      retry_after: patchRes.headers.get('retry-after') ?? null,
    };
    console.log(JSON.stringify({
      klaviyo_timing: 'upsertProfile',
      path: 'create_then_patch',
      create_status: createRes.status,
      patch_status: patchRes.status,
      ms_create: tCreate,
      ms_patch: tPatch,
      ms_total: Date.now() - tStart,
      email_hash: args.email.length,
      ratelimit_create: rateLimitInfo,
      ratelimit_patch: patchRateLimit,
    }));
    if (!patchRes.ok) throw new Error(`Klaviyo patch ${patchRes.status}: ${(await patchRes.text()).slice(0, 300)}`);
    return { id };
  }

  console.log(JSON.stringify({
    klaviyo_timing: 'upsertProfile',
    path: 'create_unexpected_status',
    status: createRes.status,
    ms_create: tCreate,
    ratelimit: rateLimitInfo,
  }));
  throw new Error(`Klaviyo create profile ${createRes.status}: ${(await createRes.text()).slice(0, 300)}`);
}

/**
 * Update only the four Rise-compatible properties on an existing profile.
 * Use when you have the Klaviyo profile ID already.
 */
export async function updateRiseProperties(profileId: string, props: RiseProfileProps): Promise<void> {
  const body = {
    data: {
      type: 'profile',
      id: profileId,
      attributes: { properties: props },
    },
  };
  const res = await fetch(`${BASE}/profiles/${profileId}/`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Klaviyo updateRiseProperties ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
