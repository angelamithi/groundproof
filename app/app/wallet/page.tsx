'use client';

import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { formatAmount } from '@/components/format';
import { SignIn } from '@/components/SignIn';
import { Withdraw } from '@/components/Withdraw';
import { getEarningsBalance } from '@/lib/chain';
import { useWorkerStats } from '@/lib/hooks';
import { useT } from '@/lib/i18n';

export default function WalletPage() {
  const { t } = useT();
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const stats = useWorkerStats();
  const balance = useQuery({
    queryKey: ['balance', account?.address],
    queryFn: () => getEarningsBalance(client, account!.address),
    enabled: !!account,
  });

  if (!account) return <SignIn />;

  return (
    <section>
      <div className="card">
        <p className="muted small">{t('balance')}</p>
        <p className="balance">{balance.data !== undefined ? formatAmount(balance.data) : '…'}</p>
        <p className="muted small mono">{account.address}</p>
      </div>
      {stats.data && (
        <div className="card stats">
          <div>
            <span className="muted small">{t('completed')}</span>
            <strong>{stats.data.completed}</strong>
          </div>
          <div>
            <span className="muted small">{t('level')}</span>
            <strong>{stats.data.level}</strong>
          </div>
          <div>
            <span className="muted small">{t('strikes')}</span>
            <strong>{stats.data.strikes}</strong>
          </div>
        </div>
      )}
      {balance.data !== undefined && <Withdraw balance={balance.data} />}
      <p className="muted small">{t('cashOut')}</p>
    </section>
  );
}
