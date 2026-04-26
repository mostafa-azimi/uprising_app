/**
 * Centralized auth helpers for app routes.
 */

import { createSupabaseServerClient } from './supabase/server';

export type Role = 'admin' | 'viewer' | 'none';

export interface SignedInUser {
  id: string;
  email: string;
  role: Role;
}

/**
 * Returns the signed-in user with their app role, or null if not signed in
 * or not in admin_users at all.
 */
export async function getSignedInUser(): Promise<SignedInUser | null> {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: row } = await supabase
    .from('admin_users')
    .select('user_id, email, role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!row) return { id: user.id, email: user.email ?? '', role: 'none' };
  return { id: user.id, email: row.email, role: (row.role as Role) ?? 'none' };
}

/** Throws if not signed in. */
export async function requireSignedIn(): Promise<SignedInUser> {
  const u = await getSignedInUser();
  if (!u) throw new Error('Not signed in');
  return u;
}

/** Throws if not admin OR viewer. Used to gate read-only routes. */
export async function requireMember(): Promise<SignedInUser> {
  const u = await requireSignedIn();
  if (u.role !== 'admin' && u.role !== 'viewer') {
    throw new Error('Forbidden — your account exists but has not been granted access. Ask an admin.');
  }
  return u;
}

/** Throws if not admin. Used to gate mutating routes. */
export async function requireAdmin(): Promise<SignedInUser> {
  const u = await requireSignedIn();
  if (u.role !== 'admin') {
    throw new Error(u.role === 'viewer' ? 'Forbidden — viewers cannot perform this action' : 'Forbidden — admin only');
  }
  return u;
}

/** Email policy for sign-up: require @dischub.com address. */
export const ALLOWED_SIGNUP_DOMAIN = 'dischub.com';
export function isAllowedSignupEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@' + ALLOWED_SIGNUP_DOMAIN);
}

/** Standard list of reasons for manual adjustments. */
export const ADJUST_REASONS: string[] = [
  'Customer service goodwill',
  'Refund or make-good',
  'Promotion or contest',
  'Trade-in credit',
  'Rise migration correction',
  'Data entry correction',
  'Bonus credit',
  'Manual debit (correction)',
  'Other',
];
