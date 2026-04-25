import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { findProfileByEmail } from '@/lib/klaviyo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Lazy redirect to a customer's Klaviyo profile.
 *   - If we already have klaviyo_profile_id stored, redirect immediately.
 *   - Otherwise, look up via Klaviyo API by email, save it, then redirect.
 *   - Falls back to Klaviyo's home if the profile can't be found.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', process.env.APP_URL || 'http://localhost:3000'));
  }

  const supabase = createSupabaseServiceClient();
  const { data: customer, error } = await supabase
    .from('customers')
    .select('id, email, klaviyo_profile_id')
    .eq('id', params.id)
    .maybeSingle();

  if (error || !customer) {
    return NextResponse.redirect('https://www.klaviyo.com/dashboard');
  }

  let profileId = customer.klaviyo_profile_id;
  if (!profileId) {
    try {
      const klaviyo = await findProfileByEmail(customer.email);
      if (klaviyo?.id) {
        profileId = klaviyo.id;
        await supabase
          .from('customers')
          .update({ klaviyo_profile_id: profileId })
          .eq('id', customer.id);
      }
    } catch {
      // Klaviyo lookup failed; fall through to dashboard
    }
  }

  if (profileId) {
    return NextResponse.redirect(`https://www.klaviyo.com/profile/${profileId}`);
  }
  return NextResponse.redirect(`https://www.klaviyo.com/dashboard`);
}
