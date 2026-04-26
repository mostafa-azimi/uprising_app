// (was the seed-from-klaviyo importer; disabled — migration happens via /admin/migrate)
// Endpoint disabled. Bulk seed will happen via direct SQL in Supabase, not via this app.
// Keeping the file as a 410 Gone so any leftover client calls fail loudly.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    { error: 'Seed endpoint disabled — use direct SQL in Supabase' },
    { status: 410 }
  );
}
