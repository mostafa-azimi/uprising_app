/**
 * Helpers for expiration-date display logic.
 */

export type ExpirationStatus = 'past' | 'soon' | 'ok' | 'unknown';

/** Return a status keyword for a YYYY-MM-DD expiration date. */
export function expirationStatus(iso: string | null | undefined, soonDays = 30): ExpirationStatus {
  if (!iso) return 'unknown';
  const exp = new Date(iso + 'T23:59:59Z').getTime();
  if (!Number.isFinite(exp)) return 'unknown';
  const now = Date.now();
  if (exp < now) return 'past';
  const horizon = now + soonDays * 24 * 60 * 60 * 1000;
  if (exp <= horizon) return 'soon';
  return 'ok';
}

/** Tailwind classes that highlight an expiration based on its status. */
export function expirationClass(iso: string | null | undefined, soonDays = 30): string {
  const s = expirationStatus(iso, soonDays);
  if (s === 'past') return 'text-bad font-semibold';
  if (s === 'soon') return 'text-bad';
  return 'text-muted';
}

/** Human-readable formatted date (Mon DD, YYYY). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
