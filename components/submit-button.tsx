'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Submit button that automatically shows loading state during a server-action
 * form submission. Prevents the "click 3 times because nothing happened"
 * problem on slower networks or Vercel cold starts.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = '',
  variant = 'primary',
}: {
  children: ReactNode;
  pendingLabel?: ReactNode;
  className?: string;
  variant?: 'primary' | 'subtle';
}) {
  const { pending } = useFormStatus();

  const base = variant === 'primary'
    ? 'bg-ink text-white hover:opacity-90 disabled:opacity-50'
    : 'text-muted hover:text-ink disabled:opacity-50';

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${base} ${className} disabled:cursor-not-allowed transition`}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <Spinner />
          {pendingLabel ?? 'Working…'}
        </span>
      ) : children}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
