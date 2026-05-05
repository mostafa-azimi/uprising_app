'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { signOut } from '@/app/login/actions';

/**
 * Persistent sidebar shell for all authenticated pages.
 *
 * Bare pages (login, root, password recovery, auth callback) are passed
 * through unchanged. Anything else gets the fixed left sidebar.
 */

const BARE_PATHS = ['/login', '/auth/callback', '/account/recovery', '/'];

interface NavItem {
  href: string;
  label: string;
  children?: { href: string; label: string }[];
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/upload/grants', label: 'Upload event credits' },
  { href: '/customers', label: 'Customers' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/change-log', label: 'Change log' },
  { href: '/events', label: 'Events' },
  { href: '/reports/expirations', label: 'Expirations' },
  {
    href: '/tools',
    label: 'Tools',
    children: [
      { href: '/admin/import-master', label: 'Import Master Rise file' },
      { href: '/admin/link-gift-cards', label: 'Link gift cards' },
      { href: '/admin/reconcile-shopify', label: 'Reconcile from Shopify (CSV)' },
      { href: '/admin/sync-shopify-balances', label: 'Sync balances from Shopify' },
      { href: '/admin/backfill-redemptions', label: 'Backfill redemptions' },
      { href: '/test-connections', label: 'Test connections' },
    ],
  },
  {
    href: '/settings',
    label: 'Settings',
    children: [
      { href: '/account', label: 'Profile & password' },
      { href: '/settings/users', label: 'Users' },
      { href: '/settings/connections/shopify', label: 'Shopify' },
      { href: '/settings/connections/klaviyo', label: 'Klaviyo' },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(href + '/');
}

function isSectionActive(pathname: string, item: NavItem): boolean {
  if (isActive(pathname, item.href)) return true;
  if (!item.children) return false;
  return item.children.some((c) => isActive(pathname, c.href));
}

interface AppShellProps {
  userEmail: string | null;
  children: React.ReactNode;
}

export function AppShell({ userEmail, children }: AppShellProps) {
  const pathname = usePathname() ?? '/';

  // Bare-mode passthrough for unauthenticated / standalone pages
  if (
    BARE_PATHS.includes(pathname) ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/account/recovery')
  ) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar pathname={pathname} userEmail={userEmail} />
      <div className="flex-1 ml-60 min-w-0">{children}</div>
    </div>
  );
}

function Sidebar({ pathname, userEmail }: { pathname: string; userEmail: string | null }) {
  // Each expandable section tracks its own open state. Auto-open whichever
  // section we're currently navigating inside of.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    NAV.forEach((item) => {
      if (item.children) initial[item.href] = isSectionActive(pathname, item);
    });
    return initial;
  });

  function toggleSection(href: string) {
    setOpenSections((prev) => ({ ...prev, [href]: !prev[href] }));
  }

  return (
    <aside className="fixed inset-y-0 left-0 w-60 bg-white border-r border-line flex flex-col">
      <div className="px-5 py-5 border-b border-line">
        <Link href="/dashboard" className="block">
          <h1 className="text-xl font-bold leading-tight">Uprising</h1>
          <p className="text-xs text-muted">Store credit manager</p>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 text-sm">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          const sectionActive = isSectionActive(pathname, item);

          if (!item.children) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-5 py-2 transition ${
                  active
                    ? 'bg-slate-100 text-ink font-medium border-l-2 border-ink -ml-px'
                    : 'text-muted hover:text-ink hover:bg-slate-50'
                }`}
              >
                {item.label}
              </Link>
            );
          }

          const isOpen = openSections[item.href] ?? false;
          return (
            <div key={item.href}>
              <div className="flex items-stretch">
                <Link
                  href={item.href}
                  className={`flex-1 px-5 py-2 transition ${
                    active
                      ? 'bg-slate-100 text-ink font-medium border-l-2 border-ink -ml-px'
                      : sectionActive
                        ? 'text-ink font-medium hover:bg-slate-50'
                        : 'text-muted hover:text-ink hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </Link>
                <button
                  onClick={() => toggleSection(item.href)}
                  aria-label={isOpen ? `Collapse ${item.label}` : `Expand ${item.label}`}
                  className="px-3 text-muted hover:text-ink hover:bg-slate-50 transition"
                  type="button"
                >
                  <span
                    className="inline-block transition-transform"
                    style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  >
                    ›
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="bg-slate-50/50 border-y border-line/50">
                  {item.children.map((c) => {
                    const childActive = isActive(pathname, c.href);
                    return (
                      <Link
                        key={c.href}
                        href={c.href}
                        className={`block pl-10 pr-5 py-1.5 transition text-xs ${
                          childActive
                            ? 'bg-slate-100 text-ink font-medium border-l-2 border-ink -ml-px'
                            : 'text-muted hover:text-ink hover:bg-slate-100'
                        }`}
                      >
                        {c.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-line px-5 py-3 text-xs">
        {userEmail && (
          <p className="text-muted truncate mb-2" title={userEmail}>
            {userEmail}
          </p>
        )}
        <SignOutButton />
      </div>
    </aside>
  );
}

function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="text-muted hover:text-ink transition">
        Sign out
      </button>
    </form>
  );
}
