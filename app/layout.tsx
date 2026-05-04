import type { Metadata } from 'next';
import { Suspense } from 'react';
import './globals.css';
import { RouteProgress } from '@/components/route-progress';
import { AppShell } from '@/components/app-shell';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Uprising — Store Credit Manager',
  description: 'Shopify gift card credits with Klaviyo profile sync',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const email = user?.email ?? null;

  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <RouteProgress />
        </Suspense>
        <AppShell userEmail={email}>{children}</AppShell>
      </body>
    </html>
  );
}
