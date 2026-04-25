/**
 * Shared helpers for the migration tool.
 */

import { createSupabaseServerClient } from './supabase/server';

export async function requireAdminUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data: admin } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!admin) throw new Error('Forbidden — not an admin');
  return user;
}

export function parseDecimal(v: string | undefined | null): number | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t || t.toLowerCase() === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseBool(v: string | undefined | null): boolean | null {
  if (v == null) return null;
  const t = String(v).trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

export function parseTimestamp(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  // Pass through to Postgres which is forgiving with various ISO/RFC formats
  return t;
}

export function parseDate(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  // Accept YYYY-MM-DD, MM/DD/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Try Date.parse fallback
  const dt = new Date(t);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

export function clean(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}
