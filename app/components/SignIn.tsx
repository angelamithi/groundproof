'use client';

import { useDAppKit, useWallets } from '@mysten/dapp-kit-react';
import { isGoogleWallet } from '@mysten/enoki';
import { useState } from 'react';
import { DEV_WALLET } from '@/lib/config';
import { useT } from '@/lib/i18n';

export function SignIn({ title, tagline }: { title?: string; tagline?: string } = {}) {
  const { t } = useT();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const google = wallets.find((w) => isGoogleWallet(w));
  const burner = DEV_WALLET ? wallets.find((w) => w.name === 'Unsafe Burner Wallet') : undefined;
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="hero">
      <h1>{title ?? 'Groundproof'}</h1>
      <p className="lead">{tagline ?? t('tagline')}</p>
      <button
        className="primary big"
        disabled={!google}
        onClick={async () => {
          setError(null);
          try {
            await dAppKit.connectWallet({ wallet: google! });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {t('signIn')}
      </button>
      {burner && (
        <button className="secondary" onClick={() => dAppKit.connectWallet({ wallet: burner })}>
          Use local test wallet (dev only)
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
