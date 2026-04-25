'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import Link from 'next/link';

interface Status {
  tablesReady: boolean;
  setupError: string | null;
  counts: {
    shopify_staging_total: number;
    shopify_staging_enabled: number;
    klaviyo_staging_total: number;
    klaviyo_staging_with_code: number;
    customers_total: number;
    customers_with_loyalty_code: number;
    customers_linked_to_gift_card: number;
  };
}

const SETUP_SQL = `-- Run once in Supabase SQL Editor before using this page.
drop table if exists shopify_gift_cards_staging;
create table shopify_gift_cards_staging (
  id bigint primary key,
  last_characters text,
  customer_name text,
  email text,
  date_issued timestamptz,
  expires_on date,
  initial_balance numeric(12,2),
  current_balance numeric(12,2),
  enabled boolean,
  expired boolean,
  note text
);
create index on shopify_gift_cards_staging (last_characters);
create index on shopify_gift_cards_staging (enabled, current_balance) where enabled = true;

drop table if exists klaviyo_profiles_staging;
create table klaviyo_profiles_staging (
  email text primary key,
  first_name text,
  last_name text,
  klaviyo_profile_id text,
  loyalty_card_code text,
  loyalty_card_balance numeric(12,2),
  last_reward numeric(12,2),
  expiration_date date,
  last_event_date timestamptz,
  imported_at timestamptz default now()
);
create index on klaviyo_profiles_staging (lower(loyalty_card_code));
create index on klaviyo_profiles_staging (lower(right(loyalty_card_code, 4)));

alter table shopify_gift_cards_staging enable row level security;
alter table klaviyo_profiles_staging enable row level security;
create policy "admins full access on shopify_gift_cards_staging" on shopify_gift_cards_staging
  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins full access on klaviyo_profiles_staging" on klaviyo_profiles_staging
  for all to authenticated using (is_admin()) with check (is_admin());`;

export default function MigratePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [reloading, setReloading] = useState(false);

  async function refresh() {
    setReloading(true);
    try {
      const res = await fetch('/api/admin/migrate/status', { cache: 'no-store' });
      if (res.ok) setStatus(await res.json());
    } finally {
      setReloading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <main className="min-h-screen px-8 py-10 max-w-4xl mx-auto">
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">← Dashboard</Link>
      <h1 className="text-3xl font-bold mt-2 mb-1">Migrate from Rise</h1>
      <p className="text-sm text-muted mb-8">
        One-time migration: load Shopify gift cards + Klaviyo profiles into staging tables, then marry them up to populate your customer roster.
      </p>

      {/* Setup status */}
      <Section title="Step 1 — Create staging tables (one-time)">
        {status === null ? (
          <p className="text-sm text-muted">Checking…</p>
        ) : status.tablesReady ? (
          <p className="text-sm text-ok">
            ✓ Staging tables exist. {status.counts.shopify_staging_total} shopify rows, {status.counts.klaviyo_staging_total} klaviyo rows currently loaded.
          </p>
        ) : (
          <>
            <p className="text-sm text-bad mb-3">
              Staging tables don't exist yet. Open Supabase SQL Editor, paste the SQL below, click Run.
              Then come back and refresh this page.
            </p>
            <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto whitespace-pre">{SETUP_SQL}</pre>
            <p className="text-xs text-muted mt-2">
              Setup error: <code>{status.setupError ?? 'unknown'}</code>
            </p>
          </>
        )}
      </Section>

      <Section title="Step 2 — Upload Shopify gift cards CSV" disabled={!status?.tablesReady}>
        <UploadBlock
          endpoint="/api/admin/migrate/import-shopify"
          accept=".csv"
          help="Shopify admin → Gift cards → Export. Upload the resulting CSV. Replaces all rows in shopify_gift_cards_staging."
          onDone={refresh}
        />
        {status?.tablesReady && (
          <div className="mt-3 text-sm text-muted">
            Currently loaded: <strong>{status.counts.shopify_staging_total}</strong> total · <strong>{status.counts.shopify_staging_enabled}</strong> enabled
          </div>
        )}
      </Section>

      <Section title="Step 3 — Upload Klaviyo profiles CSV" disabled={!status?.tablesReady}>
        <UploadBlock
          endpoint="/api/admin/migrate/import-klaviyo"
          accept=".csv"
          help="Klaviyo → Lists & segments → your Rise list → Manage list → Export list. Columns: Email, First Name, Last Name, loyalty_card_code, loyalty_card_balance, last_reward, expiration_date, last_event_date."
          onDone={refresh}
        />
        {status?.tablesReady && (
          <div className="mt-3 text-sm text-muted">
            Currently loaded: <strong>{status.counts.klaviyo_staging_total}</strong> profiles · <strong>{status.counts.klaviyo_staging_with_code}</strong> with loyalty_card_code
          </div>
        )}
      </Section>

      <Section
        title="Step 4 — Marry them up"
        disabled={!status?.tablesReady || (status?.counts.shopify_staging_total ?? 0) === 0 || (status?.counts.klaviyo_staging_total ?? 0) === 0}
      >
        <MarryUpBlock onDone={refresh} />
        {status && (
          <div className="mt-3 text-sm text-muted">
            Customers in DB: <strong>{status.counts.customers_total}</strong> ·
            with loyalty code: <strong>{status.counts.customers_with_loyalty_code}</strong> ·
            linked to gift card: <strong>{status.counts.customers_linked_to_gift_card}</strong>
          </div>
        )}
      </Section>

      <button
        onClick={refresh}
        disabled={reloading}
        className="text-sm text-muted hover:text-ink"
      >
        {reloading ? 'Refreshing…' : '⟲ Refresh status'}
      </button>
    </main>
  );
}

function Section({ title, disabled, children }: { title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <section className={`mb-8 border border-line rounded-xl bg-white p-6 ${disabled ? 'opacity-60' : ''}`}>
      <h2 className="font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
}

function UploadBlock({
  endpoint,
  accept,
  help,
  onDone,
}: {
  endpoint: string;
  accept: string;
  help: string;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSelect(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setResult(null);
    setError(null);
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('csv', file);
      const res = await fetch(endpoint, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
      } else {
        setResult(JSON.stringify(json, null, 2));
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-sm text-muted mb-3">{help}</p>
      <input
        type="file"
        accept={accept}
        onChange={onSelect}
        disabled={busy}
        className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-ink file:text-white file:font-medium hover:file:opacity-90"
      />
      {file && (
        <div className="mt-2 text-sm">
          <span className="font-medium">{file.name}</span>
          <span className="text-muted ml-2">{(file.size / 1024).toFixed(1)} KB</span>
        </div>
      )}
      <button
        onClick={upload}
        disabled={!file || busy}
        className="mt-3 bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Uploading…' : 'Upload + import'}
      </button>
      {error && <pre className="mt-3 p-3 text-xs text-bad bg-red-50 border border-bad rounded-lg whitespace-pre-wrap">{error}</pre>}
      {result && <pre className="mt-3 p-3 text-xs bg-slate-50 border border-line rounded-lg whitespace-pre-wrap">{result}</pre>}
    </>
  );
}

function MarryUpBlock({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/migrate/marry-up', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `${res.status} ${res.statusText}`);
      } else {
        setResult(JSON.stringify(json, null, 2));
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-sm text-muted mb-3">
        Upserts customers from Klaviyo staging, then links each customer's <code>shopify_gift_card_id</code>
        by matching the last 4 of <code>loyalty_card_code</code> against the Shopify gift cards staging table.
        Idempotent — safe to re-run.
      </p>
      <button
        onClick={run}
        disabled={busy}
        className="bg-ink text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Running marry-up…' : 'Run marry-up'}
      </button>
      {error && <pre className="mt-3 p-3 text-xs text-bad bg-red-50 border border-bad rounded-lg whitespace-pre-wrap">{error}</pre>}
      {result && <pre className="mt-3 p-3 text-xs bg-slate-50 border border-line rounded-lg whitespace-pre-wrap">{result}</pre>}
    </>
  );
}
