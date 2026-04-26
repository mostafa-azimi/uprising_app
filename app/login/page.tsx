import { signInWithMagicLink, signInWithPassword, requestPasswordReset } from './actions';
import { SubmitButton } from '@/components/submit-button';

type Mode = 'magic' | 'password' | 'forgot';

export default function LoginPage({ searchParams }: { searchParams: { sent?: string; error?: string; mode?: string } }) {
  const mode: Mode =
    searchParams.mode === 'password' ? 'password' :
    searchParams.mode === 'forgot' ? 'forgot' : 'magic';

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-line rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-bold mb-1">Uprising</h1>
        <p className="text-sm text-muted mb-6">Sign in to manage store credit.</p>

        <div className="flex gap-1 mb-5 p-1 bg-slate-100 rounded-lg text-sm">
          <a
            href="/login?mode=magic"
            className={`flex-1 text-center py-1.5 rounded-md transition ${mode === 'magic' ? 'bg-white shadow-sm font-medium' : 'text-muted'}`}
          >
            Magic link
          </a>
          <a
            href="/login?mode=password"
            className={`flex-1 text-center py-1.5 rounded-md transition ${mode === 'password' ? 'bg-white shadow-sm font-medium' : 'text-muted'}`}
          >
            Password
          </a>
        </div>

        {mode === 'magic' && (
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
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Sending…">
              Send magic link
            </SubmitButton>
          </form>
        )}

        {mode === 'password' && (
          <form action={signInWithPassword} className="space-y-3">
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
            <label className="block">
              <span className="text-sm font-medium">Password</span>
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                minLength={6}
                className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
              />
            </label>
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Signing in…">
              Sign in
            </SubmitButton>
            <div className="flex justify-between text-xs text-muted">
              <a href="/login?mode=forgot" className="hover:text-ink">Forgot password?</a>
              <span>First time? Use Magic link, then set a password under Settings.</span>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form action={requestPasswordReset} className="space-y-3">
            <p className="text-sm text-muted mb-1">
              Enter your email. If we have a matching account, we'll send a reset link.
            </p>
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
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Sending…">
              Send reset link
            </SubmitButton>
            <div className="text-xs text-muted">
              <a href="/login?mode=password" className="hover:text-ink">← Back to sign in</a>
            </div>
          </form>
        )}

        {searchParams.sent && (
          <p className="mt-4 text-sm text-ok">
            {mode === 'forgot' ? 'If that email exists, a reset link is on the way.' : 'Check your email for the sign-in link.'}
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
