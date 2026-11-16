'use client';

import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatAmount, formatTimeLeft } from '@/components/format';
import { SignIn } from '@/components/SignIn';
import { KIND_LABELS } from '@/lib/business';
import { getEarningsBalance, listMyTasks } from '@/lib/chain';
import { missingConfig } from '@/lib/config';

export default function BusinessHome() {
  const account = useCurrentAccount();
  const missing = missingConfig();
  if (missing.length) {
    return (
      <div className="card">
        App not configured. Missing: <code>{missing.join(', ')}</code>
      </div>
    );
  }
  if (!account) {
    return (
      <SignIn
        title="Groundproof for Business"
        tagline="Verified ground truth from across Africa: business checks, prices and local-language data, with GPS-stamped proof."
      />
    );
  }
  return <Dashboard address={account.address} />;
}

function Dashboard({ address }: { address: string }) {
  const client = useCurrentClient();
  const router = useRouter();
  const tasks = useQuery({ queryKey: ['my-tasks', address], queryFn: () => listMyTasks(client, address) });
  const balance = useQuery({ queryKey: ['balance', address], queryFn: () => getEarningsBalance(client, address) });

  const list = tasks.data ?? [];
  const now = Date.now();
  const live = list.filter((t) => !t.closed && t.deadlineMs > now);
  const inProgress = list.reduce((n, t) => n + t.active, 0);
  const completed = list.reduce((n, t) => n + t.approved, 0);
  const locked = list.filter((t) => !t.closed).reduce((n, t) => n + t.reward * BigInt(t.slots - t.approved), BigInt(0));

  return (
    <section className="wide">
      <div className="toolbar">
        <h2>Your tasks</h2>
        <Link href="/business/new" className="primary" style={{ borderRadius: 10, textAlign: 'center' }}>
          + New task
        </Link>
      </div>

      <div className="kpis" style={{ marginTop: 12 }}>
        <div className="kpi">
          <span className="muted small">Wallet balance</span>
          <strong>{balance.data !== undefined ? formatAmount(balance.data) : '…'}</strong>
          <button
            className="link small"
            title={address}
            onClick={() => navigator.clipboard?.writeText(address)}
          >
            Copy top-up address
          </button>
        </div>
        <div className="kpi">
          <span className="muted small">Live tasks</span>
          <strong>{live.length}</strong>
        </div>
        <div className="kpi">
          <span className="muted small">In progress / to review</span>
          <strong>{inProgress}</strong>
        </div>
        <div className="kpi">
          <span className="muted small">Completed checks</span>
          <strong>{completed}</strong>
        </div>
        <div className="kpi">
          <span className="muted small">Rewards in escrow</span>
          <strong>{formatAmount(locked)}</strong>
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        {tasks.isLoading && <p className="muted">Loading…</p>}
        {tasks.error && <p className="error">{(tasks.error as Error).message}</p>}
        {tasks.data?.length === 0 && (
          <p className="muted">
            No tasks yet. <Link href="/business/new">Create your first task</Link> or upload a CSV.
          </p>
        )}
        {list.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Instructions</th>
                <th>Reward</th>
                <th>Done</th>
                <th>Active</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const expired = t.deadlineMs <= now;
                return (
                  <tr key={t.id} className="clickable" onClick={() => router.push(`/business/task/${t.id}`)}>
                    <td>{KIND_LABELS[t.kind] ?? t.kind}</td>
                    <td className="small">{t.instructions.length > 70 ? `${t.instructions.slice(0, 70)}…` : t.instructions}</td>
                    <td>{formatAmount(t.reward)}</td>
                    <td>
                      {t.approved}/{t.slots}
                    </td>
                    <td>{t.active > 0 ? <span className="chip amber">{t.active}</span> : '0'}</td>
                    <td>
                      {t.closed ? (
                        <span className="chip">Closed</span>
                      ) : expired ? (
                        <span className="chip red">Expired</span>
                      ) : t.approved === t.slots ? (
                        <span className="chip green">Complete</span>
                      ) : (
                        <span className="chip blue">Live · {formatTimeLeft(t.deadlineMs)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
