import { NextResponse, type NextRequest } from 'next/server';
import { expireGrantsPastDate } from '@/lib/expire';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily cron — runs from Vercel Cron at 02:00 UTC.
 *
 * Auth: Vercel Cron requests automatically include
 *   Authorization: Bearer ${CRON_SECRET}
 * if you set CRON_SECRET in env vars. Manual GET requests without that header
 * are rejected.
 */
function verifyCron(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // No secret configured — only allow Vercel's user agent as a weaker check.
    const ua = (request.headers.get('user-agent') || '').toLowerCase();
    return ua.includes('vercel-cron');
  }
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${expected}`;
}

export async function GET(request: NextRequest) {
  if (!verifyCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await expireGrantsPastDate({ actorEmail: 'cron@auto' });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// Vercel sends GET; we also accept POST so admin tools can trigger this with
// the same secret, e.g. `curl -X POST -H "Authorization: Bearer $CRON_SECRET" ...`
export async function POST(request: NextRequest) {
  return GET(request);
}
