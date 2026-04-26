'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { inviteAdmin, removeAdmin } from './actions';
import { SubmitButton } from '@/components/submit-button';

interface Admin {
  user_id: string;
  email: string;
  created_at: string;
}

export function AdminsClient({ currentUserId, admins }: { currentUserId: string; admins: Admin[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Admin | null>(null);

  async function onInvite(formData: FormData) {
    setError(null);
    setSuccess(null);
    const result = await inviteAdmin(formData);
    if (result.ok) {
      setSuccess(result.message);
      startTransition(() => router.refresh());
    } else {
      setError(result.message);
    }
  }

  async function onRemove(userId: string) {
    setConfirmRemove(null);
    setError(null);
    setSuccess(null);
    const fd = new FormData();
    fd.append('userId', userId);
    const result = await removeAdmin(fd);
    if (result.ok) {
      setSuccess(result.message);
      startTransition(() => router.refresh());
    } else {
      setError(result.message);
    }
  }

  return (
    <>
      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-3">Invite a new admin</h2>
        <form action={onInvite} className="flex flex-wrap gap-3">
          <input
            name="email"
            type="email"
            required
            placeholder="newadmin@example.com"
            className="flex-1 min-w-[240px] border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
          />
          <SubmitButton className="px-4 py-2 rounded-lg text-sm font-medium" pendingLabel="Sending…">
            Send invite
          </SubmitButton>
        </form>
        <p className="text-xs text-muted mt-2">
          They'll get a Supabase invite email. Clicking it signs them in and sends them to the account page to set a password.
        </p>
      </section>

      {error && <div className="mb-4 p-3 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error}</div>}
      {success && <div className="mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700">{success}</div>}

      <h2 className="font-semibold mb-3">Current admins ({admins.length})</h2>
      <div className="border border-line rounded-xl bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted bg-slate-50 border-b border-line">
              <th className="py-2 px-4 font-medium">Email</th>
              <th className="py-2 px-4 font-medium">Granted</th>
              <th className="py-2 px-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.user_id} className="border-b border-line last:border-0">
                <td className="py-2 px-4">
                  {a.email}
                  {a.user_id === currentUserId && <span className="ml-2 text-xs text-muted">(you)</span>}
                </td>
                <td className="py-2 px-4 text-xs text-muted">{new Date(a.created_at).toLocaleDateString()}</td>
                <td className="py-2 px-4 text-right">
                  {a.user_id !== currentUserId && (
                    <button
                      onClick={() => setConfirmRemove(a)}
                      className="text-bad hover:underline text-sm"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h2 className="text-lg font-bold mb-2">Remove {confirmRemove.email} as admin?</h2>
            <p className="text-sm text-muted mb-4">
              They will lose access to this app immediately. Their Supabase auth account is preserved (but they can't sign in here). This can be undone by inviting them again.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-4 py-2 rounded-lg text-sm border border-line hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => onRemove(confirmRemove.user_id)}
                className="px-4 py-2 rounded-lg text-sm bg-bad text-white font-medium hover:opacity-90"
              >
                Yes, remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
