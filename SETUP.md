# Uprising — Setup Guide

This is the foundation of the Rise.ai replacement. After these steps you'll have a deployed app at `*.vercel.app` with a working sign-in and a "Test connections" page that proves Supabase, Shopify, and Klaviyo are all reachable.

The upload UIs and background jobs come in follow-up sessions.

---

## Prerequisites

- A terminal on your Mac.
- Node.js 18+ (`node --version`).
- Git installed and your GitHub authenticated locally (`git push` should "just work" to your repos).

---

## Step 1 — Apply the Supabase schema (5 min)

Open the SQL Editor in your Supabase project:

https://supabase.com/dashboard/project/mdmvodhcequneeqdslze/sql/new

1. Open the file `supabase/migrations/0001_initial_schema.sql` in this project.
2. Copy the entire contents.
3. Paste into the SQL Editor.
4. Click **Run** (bottom-right).
5. You should see `Success. No rows returned`.

> Don't worry about the "insert your admin email" comment block at the bottom — we'll do that in Step 5 once you've signed in once.

---

## Step 2 — Push the project to GitHub (2 min)

In your terminal:

```bash
cd "rise clone/uprising_app"
git init
git branch -M main
git add .
git commit -m "Initial scaffold: Next.js app, Supabase schema, Shopify+Klaviyo clients"
git remote add origin https://github.com/mostafa-azimi/uprising_app.git
git push -u origin main
```

If GitHub asks for credentials, use a Personal Access Token (Settings → Developer settings → Personal access tokens → Tokens (classic) → "repo" scope) instead of your password.

---

## Step 3 — Create the Vercel project (3 min)

1. Go to https://vercel.com/mikeazimi-dischubcoms-projects.
2. Click **Add New… → Project**.
3. Pick the **mostafa-azimi/uprising_app** repo. Click **Import**.
4. Framework will auto-detect as **Next.js**. Leave everything default.
5. Expand **Environment Variables** and add the variables below (Step 4). Add them for **Production**, **Preview**, and **Development** all checked.
6. Click **Deploy**. First build takes ~1 minute.

---

## Step 4 — Environment variables for Vercel

Add these in Vercel → Settings → Environment Variables (or during the import in Step 3).

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mdmvodhcequneeqdslze.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (from Supabase → Settings → API → "anon" key) |
| `SUPABASE_SERVICE_ROLE_KEY` | (from Supabase → Settings → API → "service_role" key — keep this secret) |
| `SHOPIFY_STORE_DOMAIN` | `dischub-2603.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | your `shpat_…` token |
| `SHOPIFY_API_VERSION` | `2025-10` |
| `KLAVIYO_API_KEY` | your `pk_…` key |
| `KLAVIYO_REVISION` | `2025-01-15` |
| `APP_URL` | (your Vercel URL once deployed, e.g. `https://uprising-app.vercel.app`) |

> **Where to find Supabase keys**: https://supabase.com/dashboard/project/mdmvodhcequneeqdslze/settings/api
> Look for "Project API keys" → copy `anon public` and `service_role`.

After you set `APP_URL`, redeploy once so it takes effect.

---

## Step 5 — Configure Supabase Auth redirect (1 min)

Supabase needs to know your Vercel URL to send magic-link emails to.

1. Go to https://supabase.com/dashboard/project/mdmvodhcequneeqdslze/auth/url-configuration
2. **Site URL**: paste your Vercel deployment URL (e.g. `https://uprising-app.vercel.app`).
3. **Redirect URLs**: add the same URL plus `/auth/callback` (e.g. `https://uprising-app.vercel.app/auth/callback`). For local dev, also add `http://localhost:3000/auth/callback`.
4. Save.

---

## Step 6 — First sign-in + grant yourself admin (2 min)

1. Open your Vercel URL.
2. Sign in with your email — `mike.azimi@shiphero.com` (or whichever you want as admin).
3. Click the magic link in your email. You'll land on the dashboard, but you'll see a yellow banner saying "Admin access not yet granted."
4. Go back to Supabase SQL Editor: https://supabase.com/dashboard/project/mdmvodhcequneeqdslze/sql/new
5. Run this SQL (replace email if needed):

   ```sql
   insert into admin_users (user_id, email)
   select id, email from auth.users where email = 'mike.azimi@shiphero.com'
   on conflict (user_id) do nothing;
   ```

6. Refresh the dashboard. The yellow banner should disappear.

---

## Step 7 — Run the connection test

1. From the dashboard, click **Test connections**.
2. Click **Run checks**.
3. You should see three green checkmarks:
    - **Supabase ✓** — customers table reachable (0 rows)
    - **Shopify ✓** — DiscHub · USD · https://dischub-2603.myshopify.com
    - **Klaviyo ✓** — Account ID and contact email

If anything is red, the error message tells you which env var is wrong or which permission is missing.

---

## Local development (optional)

```bash
cd "rise clone/uprising_app"
cp .env.example .env.local
# fill in .env.local with the same values as Vercel
npm install
npm run dev
# open http://localhost:3000
```

---

## What's next

Once Step 7 is green, the foundation is proven. Follow-up sessions will add:

- File 2 upload UI + bulk grant processing (Phase 2)
- Customer detail page + grant editing (Phase 3)
- Daily expiration cron + redemption webhook (Phase 4)
- Reconciliation dashboard (Phase 5)

---

## Security note

The credentials you pasted in chat earlier are now visible in chat history. After the deployment is verified working, please rotate:

- **Supabase database password**: Settings → Database → Reset Database Password.
- **Klaviyo API key**: Account → Settings → API Keys → delete + recreate.
- **Shopify Admin token**: Develop apps → your custom app → Uninstall, then Reinstall (auto-generates a fresh `shpat_…`).

Update Vercel env vars with the new values after rotating each.
