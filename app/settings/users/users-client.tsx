'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setUserRole, inviteUser } from './actions';
import { SubmitButton } from '@/components/submit-button';

interface User {
  user_id: string;
  email: string;
  role: 'admin' | 'viewer' | 'none';
  signed_up: string;
  last_sign_in: string | null;
  confirmed: boolean;
}

const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  viewer: 'bg-blue-50 text-blue-700 border-blue-200',
  none: 'bg-rose-50 text-rose-700 border-rose-200',
};

export function UsersClient({ currentUserId, users }: { currentUserId: string; users: User[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmRole, setConfirmRole] = useState<{ user: User; role: User['role'] } | null>(null);

  function reset() { setError(null); setSuccess(null); }

  async function changeRole(user: User, role: User['role']) {
    if (user.role === role) return;
    if (role === 'none' || (user.role === 'admin' && role !== 'admin')) {
      setConfirmRole({ user, role });
      return;
    }
    await applyRole(user, role);
  }

  async function applyRole(user: User, role: User['role']) {
    reset();
    setConfirmRole(null);
    const fd = new FormData();
    fd.append('userId', user.user_id);
    fd.append('role', role);
    const result = await setUserRole(fd);
    if (result.ok) {
      setSuccess(result.message);
      startTransition(() => router.refresh());
    } else {
      setError(result.message);
    }
  }

  async function onInvite(formData: FormData) {
    reset();
    const result = await inviteUser(formData);
    if (result.ok) {
      setSuccess(result.message);
      startTransition(() => router.refresh());
    } else {
      setError(result.message);
    }
  }

  const adminCount = users.filter((u) => u.role === 'admin').length;
  const viewerCount = users.filter((u) => u.role === 'viewer').length;
  const noneCount = users.filter((u) => u.role === 'none').length;

  return (
    <>
      <section className="border border-line rounded-xl bg-white p-6 mb-6">
        <h2 className="font-semibold mb-3">Invite a new user</h2>
        <form action={onInvite} className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="text-xs text-muted block mb-1">Email (must be @dischub.com)</label>
            <input
              name="email"
              type="email"
              required
              placeholder="newuser@dischub.com"
              pattern=".*@dischub\.com$"
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white"
            />
          </div>
          <div>
            <label className="text-xs text-muted block mb-1">Role</label>
            <select name="role" defaultValue="viewer" className="border border-line rounded-lg px-3 py-2 text-sm bg-white">
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <SubmitButton className="px-4 py-2 rounded-lg text-sm font-medium" pendingLabel="Sending…">
            Send invite
          </SubmitButton>
        </form>
      </section>

      {error && <div className="mb-4 p-3 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error}</div>}
      {success && <div className="mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700">{success}</div>}

      <p className="text-sm text-muted mb-3">
        {users.length} signed-up users · {adminCount} admin{adminCount === 1 ? '' : 's'} · {viewerCount} viewer{viewerCount === 1 ? '' : 's'} · {noneCount} no access
      </p>

      <div className="border border-line rounded-xl bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted bg-slate-50 border-b border-line">
              <th className="py-2 px-4 font-medium">Email</th>
              <th className="py-2 px-4 font-medium">Role</th>
              <th className="py-2 px-4 font-medium">Signed up</th>
              <th className="py-2 px-4 font-medium">Last sign-in</th>
              <th className="py-2 px-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isMe = u.user_id === currentUserId;
              return (
                <tr key={u.user_id} className="border-b border-line last:border-0">
                  <td className="py-2 px-4">
                    {u.email}
                    {isMe && <span className="ml-2 text-xs text-muted">(you)</span>}
                    {!u.confirmed && <span className="ml-2 text-xs text-warn">(unverified)</span>}
                  </td>
                  <td className="py-2 px-4">
                    <span className={`inline-block px-2 py-0.5 text-xs border rounded-full ${ROLE_BADGE[u.role]}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2 px-4 text-xs text-muted">{new Date(u.signed_up).toLocaleDateString()}</td>
                  <td className="py-2 px-4 text-xs text-muted">
                    {u.last_sign_in ? new Date(u.last_sign_in).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 px-4 text-right">
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u, e.target.value as User['role'])}
                      disabled={isMe}
                      className="border border-line rounded-md px-2 py-1 text-xs bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="admin">Admin</option>
                      <option value="viewer">Viewer</option>
                      <option value="none">No access</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirmRole && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h2 className="text-lg font-bold mb-2">
              {confirmRole.role === 'none' ? 'Revoke access for' : 'Change role for'} {confirmRole.user.email}?
            </h2>
            <p className="text-sm text-muted mb-4">
              {confirmRole.role === 'none' && 'They will lose access to this app immediately. Their auth account stays — you can re-grant access later.'}
              {confirmRole.role === 'viewer' && confirmRole.user.role === 'admin' && 'They will lose admin powers (no uploads, edits, expirations) but keep read access.'}
              {confirmRole.role === 'admin' && 'They will gain full admin access (uploads, edits, balance changes, ledger writes).'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRole(null)}
                className="px-4 py-2 rounded-lg text-sm border border-line hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => applyRole(confirmRole.user, confirmRole.role)}
                className={`px-4 py-2 rounded-lg text-sm text-white font-medium ${confirmRole.role === 'none' ? 'bg-bad' : 'bg-ink'}`}
              >
                Yes, set to {confirmRole.role}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
