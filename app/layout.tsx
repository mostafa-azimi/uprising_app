import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Uprising — Store Credit Manager',
  description: 'Shopify gift card credits with Klaviyo profile sync',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
