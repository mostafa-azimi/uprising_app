import { signInWithMagicLink } from './actions';

export default function LoginPage({ searchParams }: { searchParams: { sent?: string; error?: string } }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-line rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-bold mb-1">Uprising</h1>
        <p className="text-sm text-muted mb-6">Store credit manager. Sign in with a magic link.</p>

        <form action={signInWithMagicLink} className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
              placeholder="you@example.com"
            />
          </label>
          <button
            type="submit"
            className="w-full bg-ink text-white rounded-lg py-2 font-medium hover:opacity-90"
          >
            Send magic link
          </button>
        </form>

        {searchParams.sent && (
          <p className="mt-4 text-sm text-ok">
            Check your email for the sign-in link.
          </p>
        )}
        {searchParams.error && (
          <p className="mt-4 text-sm text-bad">
            {decodeURIComponent(searchParams.error)}
          </p>
        )}
      </div>
    </main>
  );
}
