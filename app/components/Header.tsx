'use client';

import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n';

export function Header() {
  const { t, lang, setLang } = useT();
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const business = usePathname().startsWith('/business');

  if (business) {
    return (
      <header className="header business">
        <Link href="/business" className="brand">
          Groundproof <span className="badge">Business</span>
        </Link>
        <nav>
          {account && (
            <>
              <Link href="/business">Tasks</Link>
              <Link href="/business/new">New task</Link>
              <button className="link" onClick={() => dAppKit.disconnectWallet()}>
                Sign out
              </button>
            </>
          )}
        </nav>
      </header>
    );
  }

  return (
    <header className="header">
      <Link href="/" className="brand">
        Groundproof
      </Link>
      <nav>
        {account && (
          <>
            <Link href="/">{t('tasks')}</Link>
            <Link href="/wallet">{t('wallet')}</Link>
          </>
        )}
        <button className="link" onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}>
          {lang === 'en' ? 'SW' : 'EN'}
        </button>
        {account && (
          <button className="link" onClick={() => dAppKit.disconnectWallet()}>
            {t('signOut')}
          </button>
        )}
      </nav>
    </header>
  );
}
