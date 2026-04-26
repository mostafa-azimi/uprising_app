import { redirect } from 'next/navigation';
import { getSignedInUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await getSignedInUser();
  if (!me || me.role !== 'admin') redirect('/dashboard');
  return children;
}
