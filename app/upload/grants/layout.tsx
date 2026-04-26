import { redirect } from 'next/navigation';
import { getSignedInUser } from '@/lib/auth';

// Server-side route segment config. Applies to the page and any server actions
// called from within it. Vercel Pro caps at 60s.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export default async function UploadGrantsLayout({ children }: { children: React.ReactNode }) {
  const me = await getSignedInUser();
  if (!me || me.role !== 'admin') {
    redirect('/dashboard');
  }
  return children;
}
