import type { Metadata, Viewport } from 'next';
import { Header } from '@/components/Header';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Groundproof',
  description: 'Get paid to verify the real world around you.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f5132',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
