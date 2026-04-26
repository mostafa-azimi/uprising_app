import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen px-8 py-10 max-w-5xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Settings</h1>
      <p className="text-sm text-muted mb-8">
        Signed in as <strong>{user?.email}</strong>.
      </p>

      <h2 className="text-lg font-semibold mb-3">Account</h2>
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card href="/account" title="Profile & password" desc="Set or change your password. Your sign-in email cannot be changed here." />
        <Card href="/settings/admins" title="Admin users" desc="Invite or remove people who can sign in to this app." />
      </section>

      <h2 className="text-lg font-semibold mb-3">Integrations</h2>
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Card href="/settings/connections/shopify" title="Shopify" desc="Config display + resync gift card balances from Shopify." />
        <Card href="/settings/connections/klaviyo" title="Klaviyo" desc="Config display + push current customer state to Klaviyo." />
        <Card href="/test-connections" title="Test connections" desc="Verify Supabase, Shopify, and Klaviyo are reachable." />
        <Card href="/admin/migrate" title="Migrate from Rise" desc="Upload Shopify gift cards + Klaviyo profiles, marry them up." />
      </section>

      <h2 className="text-lg font-semibold mb-3">Danger zone</h2>
      <section className="border border-line rounded-xl bg-white p-6 text-sm text-muted">
        <p className="mb-2">Future: configure default credit expiration, expiration warning windows, currency, etc.</p>
        <p>For now, all defaults are set in code (default credit expiration = 6 months, expiration warning at 30 days).</p>
      </section>
    </main>
  );
}

function Card({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="block p-6 border border-line rounded-xl bg-white hover:border-ink transition">
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted">{desc}</p>
    </Link>
  );
}
