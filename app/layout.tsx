import type { Metadata } from 'next';
import { Suspense } from 'react';
import './globals.css';
import { RouteProgress } from '@/components/route-progress';

export const metadata: Metadata = {
  title: 'Uprising — Store Credit Manager',
  description: 'Shopify gift card credits with Klaviyo profile sync',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <RouteProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
