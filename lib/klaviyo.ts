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
export async function findProfileByEmail(email: string): Promise<{ id: string; email: string; first_name: string | null; last_name: string | null } | null> {
  const url = new URL(`${BASE}/profiles/`);
  url.searchParams.set('filter', `equals(email,"${email}")`);
  url.searchParams.set('fields[profile]', 'email,first_name,last_name');

  const res = await fetch(url, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Klaviyo profiles ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { data: Array<{ id: string; attributes: { email: string; first_name: string | null; last_name: string | null } }> };
  const p = json.data[0];
  return p ? { id: p.id, email: p.attributes.email, first_name: p.attributes.first_name, last_name: p.attributes.last_name } : null;
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

  // Try create first
  const createRes = await fetch(`${BASE}/profiles/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (createRes.status === 201 || createRes.status === 200) {
    const json = (await createRes.json()) as { data: { id: string } };
    return { id: json.data.id };
  }

  // 409 = already exists. Patch by ID.
  if (createRes.status === 409) {
    const conflict = (await createRes.json()) as { errors?: Array<{ meta?: { duplicate_profile_id?: string } }> };
    const id = conflict.errors?.[0]?.meta?.duplicate_profile_id;
    if (!id) throw new Error('Klaviyo 409 without duplicate_profile_id');

    const patchBody = { data: { type: 'profile', id, attributes: body.data.attributes } };
    const patchRes = await fetch(`${BASE}/profiles/${id}/`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(patchBody),
      cache: 'no-store',
    });
    if (!patchRes.ok) throw new Error(`Klaviyo patch ${patchRes.status}: ${(await patchRes.text()).slice(0, 300)}`);
    return { id };
  }

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
