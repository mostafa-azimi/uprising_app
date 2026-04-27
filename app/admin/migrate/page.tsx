import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function DeprecatedMigratePage() {
  return (
    <main className="min-h-screen px-8 py-10 max-w-2xl mx-auto">
      <Link href="/settings" className="text-sm text-muted hover:text-ink">← Settings</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Migrate from Rise (deprecated)</h1>
      <p className="text-sm text-muted mb-6">
        The two-CSV staging import has been replaced by a single-file importer
        that takes Rise's master export directly.
      </p>

      <Link
        href="/admin/import-master"
        className="inline-block bg-ink text-white px-5 py-3 rounded-lg font-medium hover:opacity-90"
      >
        → Open the new Master Rise importer
      </Link>
    </main>
  );
}
