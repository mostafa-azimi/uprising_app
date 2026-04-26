import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { expireGrantsPastDate } from '@/lib/expire';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Admin-callable endpoint to run the past-date sweep on demand.
 * Optional body: { cutoffISO: 'YYYY-MM-DD' } to expire anything before that date.
 */
export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { cutoffISO?: string };

  try {
    const result = await expireGrantsPastDate({
      cutoffISO: body.cutoffISO,
      actorEmail: user.email,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
