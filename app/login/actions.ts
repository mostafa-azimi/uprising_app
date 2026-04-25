'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function signInWithMagicLink(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!email) redirect('/login?error=Email%20required');

  const supabase = createSupabaseServerClient();
  const origin = headers().get('origin') ?? process.env.APP_URL ?? 'http://localhost:3000';

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect('/login?sent=1');
}

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) redirect('/login?error=Email%20and%20password%20required');

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect('/dashboard');
}

export async function signOut() {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
