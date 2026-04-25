'use server';

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function setPassword(formData: FormData) {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  if (password.length < 8) redirect('/account?error=Password%20must%20be%20at%20least%208%20characters');
  if (password !== confirm) redirect('/account?error=Passwords%20do%20not%20match');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect(`/account?error=${encodeURIComponent(error.message)}`);
  redirect('/account?ok=Password%20updated');
}
