import type { Metadata } from 'next';
import { Suspense } from 'react';
import './globals.css';
import { RouteProgress } from '@/components/route-progress';
import { AppShell } from '@/components/app-shell';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Uprising — Store Credit Manager',
  description: 'Shopify gift card credits with Klaviyo profile sync',
};

/**
 * Count customers with unresolved Klaviyo terminal failures. A failure is
 * "resolved" when a successful Klaviyo push for the same customer happens
 * after the failure timestamp.
 */
async function getKlaviyoFailureCount(): Promise<number> {
  try {
    const supabase = createSupabaseServiceClient();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: failures } = await supabase
      .from('sync_log')
      .select('entity_id, created_at')
      .eq('target', 'klaviyo')
      .eq('operation', 'profile_property_sync_failed_after_retries')
      .gte('created_at', since)
      .order('created_at', { ascending: false });

    if (!failures || failures.length === 0) return 0;

    const latestFailureByCustomer = new Map<string, string>();
    for (const f of failures) {
      if (!f.entity_id) continue;
      if (!latestFailureByCustomer.has(f.entity_id)) {
        latestFailureByCustomer.set(f.entity_id, f.created_at);
      }
    }

    const customerIds = Array.from(latestFailureByCustomer.keys());
    if (customerIds.length === 0) return 0;

    const { data: successes } = await supabase
      .from('sync_log')
      .select('entity_id, created_at')
      .eq('target', 'klaviyo')
      .eq('operation', 'profile_property_sync')
      .eq('ok', true)
      .in('entity_id', customerIds)
      .gte('created_at', since);

    const latestSuccessByCustomer = new Map<string, string>();
    (successes ?? []).forEach((s) => {
      if (!s.entity_id) return;
      const cur = latestSuccessByCustomer.get(s.entity_id);
      if (!cur || s.created_at > cur) latestSuccessByCustomer.set(s.entity_id, s.created_at);
    });

    let unresolved = 0;
    for (const [cid, failTs] of latestFailureByCustomer) {
      const successTs = latestSuccessByCustomer.get(cid);
      if (!successTs || successTs < failTs) unresolved++;
    }
    return unresolved;
  } catch {
    return 0;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const email = user?.email ?? null;

  const klaviyoFailureCount = email ? await getKlaviyoFailureCount() : 0;

  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <RouteProgress />
        </Suspense>
        <AppShell userEmail={email} klaviyoFailureCount={klaviyoFailureCount}>{children}</AppShell>
      </body>
    </html>
  );
}
