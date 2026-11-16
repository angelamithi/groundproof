'use client';

import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { formatAmount, formatKm, formatTimeLeft } from '@/components/format';
import { SignIn } from '@/components/SignIn';
import { listOpenTasks } from '@/lib/chain';
import { missingConfig } from '@/lib/config';
import { decode, distanceKm } from '@/lib/geohash';
import { usePosition, useSponsoredExecute, useWorkerStats } from '@/lib/hooks';
import { useT, type Key } from '@/lib/i18n';
import { registerTx } from '@/lib/tx';

export default function Home() {
  const { t } = useT();
  const account = useCurrentAccount();
  const missing = missingConfig();

  if (missing.length > 0) {
    return (
      <div className="card">
        <p>{t('setupMissing')}</p>
        <ul>{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
      </div>
    );
  }
  if (!account) return <SignIn />;
  return <Worker />;
}

function Worker() {
  const { t } = useT();
  const stats = useWorkerStats();
  const execute = useSponsoredExecute();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (stats.isLoading) return <div className="center muted">…</div>;

  if (!stats.data) {
    return (
      <section className="hero">
        <p className="lead">{t('tagline')}</p>
        <button
          className="primary big"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await execute(registerTx());
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('registering') : t('register')}
        </button>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  if (stats.data.banned) return <p className="card error">{t('banned')}</p>;
  return <TaskList />;
}

function TaskList() {
  const { t } = useT();
  const client = useCurrentClient();
  const { pos, error: posError } = usePosition();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => listOpenTasks(client), refetchInterval: 30_000 });

  const withDistance = (tasks.data ?? [])
    .map((task) => ({
      task,
      km: pos ? distanceKm(pos, decode(task.locationCell)) : null,
    }))
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));

  return (
    <section>
      <h2>{t('openTasks')}</h2>
      {posError && <p className="warn">{t('locationNeeded')}</p>}
      {!pos && !posError && <p className="muted">{t('locating')}</p>}
      {tasks.isLoading && <p className="muted">…</p>}
      {tasks.error && <p className="error">{(tasks.error as Error).message}</p>}
      {tasks.data?.length === 0 && <p className="muted">{t('noTasks')}</p>}
      <ul className="list">
        {withDistance.map(({ task, km }) => (
          <li key={task.id}>
            <Link href={`/task/${task.id}`} className="card task">
              <div className="row">
                <strong>{t(`kind${task.kind}` as Key)}</strong>
                <span className="pay">{formatAmount(task.reward)}</span>
              </div>
              <div className="row muted small">
                <span>{km === null ? '' : `${formatKm(km)} ${t('away')}`}</span>
                <span>
                  {task.openSlots} {t('slotsLeft')} · {formatTimeLeft(task.deadlineMs)}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
