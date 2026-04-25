'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Top-of-page progress bar that animates during route transitions.
 *
 * Reacts to pathname/searchParams changes and intercepts internal anchor
 * clicks so the bar starts moving the moment the user clicks a Link.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);

  // Start the bar on internal link clicks
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;
      // Only track same-origin internal navigations
      if (anchor.target === '_blank') return;
      if (anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;

      setActive(true);
      setProgress(15);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Tick the bar forward while active
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setProgress((p) => (p < 90 ? p + (90 - p) * 0.1 : p));
    }, 200);
    return () => window.clearInterval(id);
  }, [active]);

  // Finish the bar whenever the route changes (i.e. transition complete)
  useEffect(() => {
    if (!active) return;
    setProgress(100);
    const t = window.setTimeout(() => {
      setActive(false);
      setProgress(0);
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: `${progress}%`,
          height: '100%',
          background: '#0F172A',
          opacity: active ? 1 : 0,
          transition: 'width 200ms ease-out, opacity 250ms ease-out',
        }}
      />
    </div>
  );
}
