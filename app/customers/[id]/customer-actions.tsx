'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const ADJUST_REASONS = [
  'Customer service goodwill',
  'Refund or make-good',
  'Promotion or contest',
  'Trade-in credit',
  'Rise migration correction',
  'Data entry correction',
  'Bonus credit',
  'Manual debit (correction)',
  'Other',
];

export function CustomerActions({
  customerId,
  email,
  currentBalance,
  loyaltyCardCode,
  expirationDate,
}: {
  customerId: string;
  email: string;
  currentBalance: number;
  loyaltyCardCode: string | null;
  expirationDate: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [confirmExpire, setConfirmExpire] = useState(false);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReasonChoice, setAdjustReasonChoice] = useState<string>(ADJUST_REASONS[0]);
  const [adjustReasonOther, setAdjustReasonOther] = useState('');
  const [adjustExpires, setAdjustExpires] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit-fields panel state
  const [editEmail, setEditEmail] = useState(email);
  const [editCode, setEditCode] = useState(loyaltyCardCode ?? '');
  const [editExpiration, setEditExpiration] = useState(expirationDate ?? '');
  const [editBusy, setEditBusy] = useState(false);
  const [confirmEmailChange, setConfirmEmailChange] = useState(false);

  function reset() {
    setError(null);
    setSuccess(null);
  }

  async function saveFields(skipEmailConfirm = false) {
    reset();
    const updates: Record<string, string> = {};
    if (editEmail.trim().toLowerCase() !== email.toLowerCase()) updates.email = editEmail.trim().toLowerCase();
    if (editCode.trim() !== (loyaltyCardCode ?? '')) updates.loyalty_card_code = editCode.trim();
    if ((editExpiration || '') !== (expirationDate ?? '')) updates.expiration_date = editExpiration;

    if (Object.keys(updates).length === 0) {
      setSuccess('No changes to save.');
      return;
    }

    if (updates.email && !skipEmailConfirm) {
      setConfirmEmailChange(true);
      return;
    }

    setEditBusy(true);
    setConfirmEmailChange(false);
    try {
      const res = await fetch(`/api/customers/${customerId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const klaviyoNote = json.klaviyo ? ` Klaviyo: ${json.klaviyo}.` : '';
      setSuccess(`Saved ${(json.updates ?? []).join(', ')}.${klaviyoNote}`);
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  async function expire() {
    reset();
    setBusy(true);
    setConfirmExpire(false);
    try {
      const res = await fetch(`/api/customers/${customerId}/expire`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setSuccess(`Expired $${json.shopify_debited?.toFixed?.(2) ?? '0.00'} for ${email}.`);
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyAdjust() {
    reset();
    const amount = Number(adjustAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      setError('Enter a non-zero amount (positive to credit, negative to debit).');
      return;
    }
    const reason = adjustReasonChoice === 'Other'
      ? adjustReasonOther.trim()
      : adjustReasonChoice.trim();
    if (!reason) {
      setError('Reason is required.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          reason,
          expiresOn: adjustExpires || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      setSuccess(`Balance is now $${json.new_balance?.toFixed?.(2) ?? '0.00'}.`);
      setAdjustAmount('');
      setAdjustReasonChoice(ADJUST_REASONS[0]);
      setAdjustReasonOther('');
      setAdjustExpires('');
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-line rounded-xl bg-white p-6 mb-8">
      <h2 className="text-lg font-semibold mb-4">Actions</h2>

      {error && <div className="mb-3 p-3 rounded-lg border border-bad bg-red-50 text-sm text-bad">{error}</div>}
      {success && <div className="mb-3 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700">{success}</div>}

      {/* Edit profile fields */}
      <div className="mb-6 border-b border-line pb-6">
        <h3 className="font-medium mb-2">Edit profile fields</h3>
        <p className="text-xs text-muted mb-3">
          Updates our database and syncs the relevant Klaviyo properties. Email changes also update the Klaviyo profile (manual merge may be needed if Klaviyo already has another profile with the new email).
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-xs text-muted block mb-1">Email</span>
            <input
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted block mb-1">Loyalty card code</span>
            <input
              type="text"
              value={editCode}
              onChange={(e) => setEditCode(e.target.value)}
              placeholder="e.g. fec7cebc5c20f91e"
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white font-mono focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted block mb-1">Expiration date (display)</span>
            <input
              type="date"
              value={editExpiration}
              onChange={(e) => setEditExpiration(e.target.value)}
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
        </div>
        <button
          onClick={() => saveFields()}
          disabled={editBusy}
          className="mt-3 bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {editBusy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-6">
        {/* Manual adjust */}
        <div>
          <h3 className="font-medium mb-2">Manual adjustment</h3>
          <p className="text-xs text-muted mb-3">
            Positive amount adds credit (creates a "Manual Adjustments" grant). Negative amount debits (FIFO across active grants). Both also adjust Shopify and Klaviyo.
          </p>
          <div className="space-y-2">
            <input
              type="number"
              step="0.01"
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
              placeholder="Amount (e.g. 5.00 or -2.50)"
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
            />
            <select
              value={adjustReasonChoice}
              onChange={(e) => setAdjustReasonChoice(e.target.value)}
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
            >
              {ADJUST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {adjustReasonChoice === 'Other' && (
              <input
                type="text"
                value={adjustReasonOther}
                onChange={(e) => setAdjustReasonOther(e.target.value)}
                placeholder="Custom reason (required)"
                className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
              />
            )}
            <input
              type="date"
              value={adjustExpires}
              onChange={(e) => setAdjustExpires(e.target.value)}
              className="w-full border border-line rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-ink"
            />
            <p className="text-xs text-muted">Optional expiration (only used for credits). Default: 1 year from today.</p>
            <button
              onClick={applyAdjust}
              disabled={busy}
              className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {busy ? 'Applying…' : 'Apply adjustment'}
            </button>
          </div>
        </div>

        {/* Expire all */}
        <div>
          <h3 className="font-medium mb-2">Expire all balance</h3>
          <p className="text-xs text-muted mb-3">
            Zero out the customer's entire current balance immediately. Marks all active grants expired, debits Shopify, syncs Klaviyo, writes ledger entries.
          </p>
          <p className="text-sm mb-3">
            Current balance: <strong>${currentBalance.toFixed(2)}</strong>
          </p>
          <button
            onClick={() => setConfirmExpire(true)}
            disabled={busy || currentBalance <= 0}
            className="bg-bad text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            Expire balance
          </button>
        </div>
      </div>

      {confirmEmailChange && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h2 className="text-lg font-bold mb-2">Change customer email?</h2>
            <p className="text-sm text-muted mb-2">
              <strong>{email}</strong> → <strong>{editEmail.trim().toLowerCase()}</strong>
            </p>
            <p className="text-sm text-muted mb-4">
              Email is the primary identifier across our app, Klaviyo, and Shopify webhooks.
              We'll update our DB and create/update the Klaviyo profile. If Klaviyo already has a profile with the new email,
              you may need to manually merge them in Klaviyo.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmEmailChange(false)}
                className="px-4 py-2 rounded-lg text-sm border border-line hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => saveFields(true)}
                className="px-4 py-2 rounded-lg text-sm bg-ink text-white font-medium"
              >
                Yes, change email
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmExpire && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
            <h2 className="text-lg font-bold mb-2">Expire balance for {email}?</h2>
            <p className="text-sm text-muted mb-4">
              This will zero out <strong>${currentBalance.toFixed(2)}</strong> in Shopify, mark all active grants expired, and update Klaviyo.
            </p>
            <p className="text-sm font-semibold text-bad mb-5">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmExpire(false)}
                className="px-4 py-2 rounded-lg text-sm border border-line hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={expire}
                className="px-4 py-2 rounded-lg text-sm bg-bad text-white font-medium hover:opacity-90"
              >
                Yes, expire ${currentBalance.toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
