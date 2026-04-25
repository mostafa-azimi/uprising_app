// Server-side route segment config. Applies to the page and any server actions
// called from within it. Vercel Hobby caps at 10s, Pro at 60s, Enterprise higher.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export default function UploadGrantsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
