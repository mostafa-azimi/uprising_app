import { signInWithMagicLink, signInWithPassword, signUpWithPassword, requestPasswordReset } from './actions';
import { SubmitButton } from '@/components/submit-button';

type Mode = 'password' | 'magic' | 'signup' | 'forgot';

const AUTOFILL_EMAIL = 'mike.azimi@dischub.com';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { sent?: string; error?: string; mode?: string; autofill?: string };
}) {
  const mode: Mode =
    searchParams.mode === 'magic' ? 'magic' :
    searchParams.mode === 'signup' ? 'signup' :
    searchParams.mode === 'forgot' ? 'forgot' :
    'password';

  // ?autofill=1 prefills the email field. Bookmark /login?autofill=1 for one-click sign-in
  // (email is filled, browser password manager fills the password).
  const autofill = searchParams.autofill === '1';
  const prefillEmail = autofill ? AUTOFILL_EMAIL : '';

  // When autofill is on, propagate it to the mode-switcher links so the
  // prefill survives switching tabs.
  const linkSuffix = autofill ? '&autofill=1' : '';

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-line rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-bold mb-1">Uprising</h1>
        <p className="text-sm text-muted mb-6">Sign in to manage store credit.</p>

        <div className="flex gap-1 mb-5 p-1 bg-slate-100 rounded-lg text-sm">
          <a
            href={`/login?mode=password${linkSuffix}`}
            className={`flex-1 text-center py-1.5 rounded-md transition ${mode === 'password' || mode === 'forgot' ? 'bg-white shadow-sm font-medium' : 'text-muted'}`}
          >
            Sign in
          </a>
          <a
            href={`/login?mode=magic${linkSuffix}`}
            className={`flex-1 text-center py-1.5 rounded-md transition ${mode === 'magic' ? 'bg-white shadow-sm font-medium' : 'text-muted'}`}
          >
            Magic link
          </a>
          <a
            href={`/login?mode=signup${linkSuffix}`}
            className={`flex-1 text-center py-1.5 rounded-md transition ${mode === 'signup' ? 'bg-white shadow-sm font-medium' : 'text-muted'}`}
          >
            Create account
          </a>
        </div>

        {autofill && (
          <p className="mb-3 text-xs text-muted">
            Email prefilled: <strong>{AUTOFILL_EMAIL}</strong>. Your browser&apos;s password manager
            should fill the password — just click Sign in.
          </p>
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
                defaultValue={prefillEmail}
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
                autoFocus={autofill}
                className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
              />
            </label>
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Signing in…">
              Sign in
            </SubmitButton>
            <div className="text-xs text-muted text-center">
              <a href={`/login?mode=forgot${linkSuffix}`} className="hover:text-ink">Forgot your password?</a>
            </div>
          </form>
        )}

        {mode === 'magic' && (
          <form action={signInWithMagicLink} className="space-y-3">
            <p className="text-sm text-muted mb-1">No password — just enter your email and we'll send you a sign-in link.</p>
            <label className="block">
              <span className="text-sm font-medium">Email</span>
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                defaultValue={prefillEmail}
                className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
                placeholder="you@example.com"
              />
            </label>
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Sending…">
              Send magic link
            </SubmitButton>
          </form>
        )}

        {mode === 'signup' && (
          <form action={signUpWithPassword} className="space-y-3">
            <p className="text-sm text-muted mb-1">
              Create an account. After verifying your email, an existing admin still needs to grant you access.
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
            <label className="block">
              <span className="text-sm font-medium">Password</span>
              <input
                name="password"
                type="password"
                required
                autoComplete="new-password"
                minLength={8}
                className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
              />
            </label>
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Creating…">
              Create account
            </SubmitButton>
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
                defaultValue={prefillEmail}
                className="mt-1 w-full border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ink"
                placeholder="you@example.com"
              />
            </label>
            <SubmitButton className="w-full rounded-lg py-2 font-medium" pendingLabel="Sending…">
              Send reset link
            </SubmitButton>
            <div className="text-xs text-muted text-center">
              <a href={`/login?mode=password${linkSuffix}`} className="hover:text-ink">← Back to sign in</a>
            </div>
          </form>
        )}

        {searchParams.sent && (
          <p className="mt-4 text-sm text-ok">
            {mode === 'forgot' ? 'If that email exists, a reset link is on the way.' :
             mode === 'signup' ? 'Account created. Check your email to verify, then sign in.' :
             'Check your email for the sign-in link.'}
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
