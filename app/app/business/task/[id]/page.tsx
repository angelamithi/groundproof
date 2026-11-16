'use client';

import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { SessionKey } from '@mysten/seal';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { formatAmount, formatKm, formatTimeLeft } from '@/components/format';
import { SignIn } from '@/components/SignIn';
import { KIND_LABELS, downloadText, toCsv } from '@/lib/business';
import { getPlatformConfig, getTask, listClaims } from '@/lib/chain';
import { API_URL } from '@/lib/config';
import { decode, distanceKm } from '@/lib/geohash';
import { useSponsoredExecute } from '@/lib/hooks';
import { createSealSession, openProof, verifyProof, type ProofBundle, type Verification } from '@/lib/proof';
import { approveTx, closeTx, rejectTx } from '@/lib/tx';
import { ClaimStatus, type Claim, type Task } from '@/lib/types';

const STATUS: Record<number, [string, string]> = {
  [ClaimStatus.Claimed]: ['Worker on the way', 'blue'],
  [ClaimStatus.Submitted]: ['Needs your review', 'amber'],
  [ClaimStatus.Approved]: ['Approved · paid', 'green'],
  [ClaimStatus.Rejected]: ['Rejected', 'red'],
  [ClaimStatus.Expired]: ['Expired', ''],
  [ClaimStatus.PendingRejection]: ['Rejected · worker may dispute', 'red'],
  [ClaimStatus.Disputed]: ['Disputed · verifier reviewing', 'amber'],
};

type Opened = { bundle: ProofBundle; check: Verification };
type FraudCheck = { risk: number; verdict: string; flags: { code: string; detail: string; weight: number }[] };

function FraudBadge({ check }: { check: FraudCheck }) {
  if (check.verdict === 'error') return <p className="chip">Fraud check pending</p>;
  const [label, color] =
    check.verdict === 'ok'
      ? ['Fraud check passed', 'green']
      : check.verdict === 'review'
        ? ['Fraud check: needs a closer look', 'amber']
        : ['Fraud check: likely fake', 'red'];
  return (
    <div>
      <p className={`chip ${color}`}>
        {label} · risk {check.risk}/100
      </p>
      {check.flags.length > 0 && (
        <ul className="small muted" style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
          {check.flags.map((f, i) => (
            <li key={i}>{f.detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ANSWER_LABELS: Record<string, string> = {
  exists: 'Business open and operating',
  signName: 'Name on the sign',
  hours: 'Opening hours',
  prices: 'Items and prices',
  answer: 'Answer',
  notes: 'Worker notes',
};

export default function BusinessTaskPage() {
  const { id } = useParams<{ id: string }>();
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const execute = useSponsoredExecute();

  const task = useQuery({ queryKey: ['task', id], queryFn: () => getTask(client, id) });
  const claims = useQuery({
    queryKey: ['claims', id],
    queryFn: () => listClaims(client, task.data!),
    enabled: !!task.data,
    refetchInterval: 20_000,
  });
  const config = useQuery({ queryKey: ['config'], queryFn: () => getPlatformConfig(client) });
  const checks = useQuery({
    queryKey: ['checks', id],
    enabled: !!API_URL,
    refetchInterval: 20_000,
    queryFn: async () => {
      const res = await fetch(`${API_URL}/v1/checks/${id}`);
      if (!res.ok) return {} as Record<string, FraudCheck>;
      const rows = (await res.json()) as (FraudCheck & { worker: string })[];
      return Object.fromEntries(rows.map((r) => [r.worker.toLowerCase(), r]));
    },
  });

  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One Seal session (one wallet signature) is reused for every proof on this page.
  const session = useRef<SessionKey | null>(null);
  const getSession = useCallback(async () => {
    if (session.current && !session.current.isExpired()) return session.current;
    session.current = await createSealSession(client, account!.address, async (message) => {
      const { signature } = await dAppKit.signPersonalMessage({ message });
      return signature;
    });
    return session.current;
  }, [account, client, dAppKit]);

  if (!account) return <SignIn title="Groundproof for Business" tagline="Sign in to review proof." />;
  if (task.isLoading) return <p className="center muted">Loading…</p>;
  if (task.error) return <p className="error">{(task.error as Error).message}</p>;
  const t = task.data!;
  const isOwner = t.requester.toLowerCase() === account.address.toLowerCase();

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function open(c: Claim) {
    await run(`open-${c.worker}`, async () => {
      const bundle = await openProof(client, t.id, t.coinType, c.proofBlobId, getSession);
      const check = await verifyProof(bundle, t.id, c.worker, c.answerHash);
      setOpened((o) => ({ ...o, [c.worker]: { bundle, check } }));
    });
  }

  function exportCsv() {
    const answerKeys = [
      ...new Set(Object.values(opened).flatMap((o) => Object.keys(o.bundle.answers))),
    ].sort();
    const rows: (string | number)[][] = [
      ['task_id', 'worker', 'status', 'submitted_at', 'captured_area', 'proof_blob', 'verified', ...answerKeys],
      ...(claims.data ?? []).map((c) => {
        const o = opened[c.worker];
        return [
          t.id,
          c.worker,
          STATUS[c.status]?.[0] ?? c.status,
          c.submittedAtMs ? new Date(c.submittedAtMs).toISOString() : '',
          c.capturedCell,
          c.proofBlobId,
          o ? (o.check.ok ? 'yes' : 'NO') : 'not opened',
          ...answerKeys.map((k) => o?.bundle.answers[k] ?? ''),
        ];
      }),
    ];
    downloadText(`groundproof-${t.id.slice(0, 10)}.csv`, toCsv(rows));
  }

  return (
    <section className="wide">
      <div className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>{KIND_LABELS[t.kind]}</h2>
          <div className="actions">
            <button className="secondary" onClick={exportCsv} disabled={!claims.data?.length}>
              Export CSV
            </button>
            {isOwner && !t.closed && (
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  confirm('Close this task? Unclaimed slots are refunded now; no new workers can join.') &&
                  run('close', () => execute(closeTx(t.id, t.coinType)))
                }
              >
                {busy === 'close' ? 'Closing…' : 'Close and refund'}
              </button>
            )}
          </div>
        </div>
        <p className="instructions">{t.instructions}</p>
        <p className="muted small">
          {formatAmount(t.reward)} per worker · {t.approved}/{t.slots} approved · {t.active} in progress · area{' '}
          {t.locationCell} ·{' '}
          {t.closed ? 'closed' : t.deadlineMs > Date.now() ? `${formatTimeLeft(t.deadlineMs)} left` : 'deadline passed'}
        </p>
        {!isOwner && <p className="warn small">You didn't create this task, so you can't open its proofs.</p>}
      </div>

      {claims.isLoading && <p className="muted">Loading submissions…</p>}
      {claims.data?.length === 0 && <p className="card muted">No worker has taken this task yet.</p>}

      {claims.data?.map((c) => {
        const [label, color] = STATUS[c.status] ?? [String(c.status), ''];
        const o = opened[c.worker];
        const reviewable = c.status === ClaimStatus.Submitted;
        const reconsider = c.status === ClaimStatus.PendingRejection || c.status === ClaimStatus.Disputed;
        const hasProof = !!c.proofBlobId;
        const autoReleaseAt = c.submittedAtMs + (config.data?.autoReleaseMs ?? 0);
        return (
          <div className="card" key={c.worker}>
            <div className="toolbar">
              <span className="mono small">{c.worker.slice(0, 10)}…{c.worker.slice(-6)}</span>
              <span className={`chip ${color}`}>{label}</span>
            </div>
            {c.submittedAtMs > 0 && (
              <p className="muted small">
                Submitted {new Date(c.submittedAtMs).toLocaleString()} · captured in area {c.capturedCell}
                {c.capturedCell &&
                  (c.capturedCell === t.locationCell
                    ? ' (same area as the task)'
                    : ` (about ${formatKm(distanceKm(decode(c.capturedCell), decode(t.locationCell)))} from task area)`)}
              </p>
            )}
            {reviewable && config.data && (
              <p className="muted small">
                Review by {new Date(autoReleaseAt).toLocaleString()}, or the worker is paid automatically.
              </p>
            )}

            {checks.data?.[c.worker.toLowerCase()] && <FraudBadge check={checks.data[c.worker.toLowerCase()]} />}
            {hasProof && isOwner && !o && (
              <button className="secondary" disabled={!!busy} onClick={() => open(c)}>
                {busy === `open-${c.worker}` ? 'Decrypting…' : 'Open proof'}
              </button>
            )}
            {o && <ProofView opened={o} task={t} />}

            {isOwner && (reviewable || reconsider) && (
              <div className="actions">
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() => run(`approve-${c.worker}`, () => execute(approveTx(t.id, t.coinType, c.worker)))}
                >
                  {busy === `approve-${c.worker}` ? 'Paying…' : `Approve and pay ${formatAmount(t.reward)}`}
                </button>
                {reviewable && (
                  <>
                    <button
                      className="secondary"
                      disabled={!!busy}
                      onClick={() => run(`reject-${c.worker}`, () => execute(rejectTx(t.id, t.coinType, c.worker, false)))}
                    >
                      Reject (not usable)
                    </button>
                    <button
                      className="danger"
                      disabled={!!busy}
                      onClick={() =>
                        confirm('Report as fraud? If the rejection stands, the worker gets a strike (3 = ban).') &&
                        run(`fraud-${c.worker}`, () => execute(rejectTx(t.id, t.coinType, c.worker, true)))
                      }
                    >
                      Reject as fraud
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ProofView({ opened, task }: { opened: Opened; task: Task }) {
  const { bundle, check } = opened;
  const taskPoint = decode(task.locationCell);
  return (
    <div>
      <p className={check.ok ? 'chip green' : 'chip red'}>
        {check.ok ? '✓ Matches the on-chain record' : `✗ ${check.problems.join('; ')}`}
      </p>
      <div className="proof-photos">
        {bundle.photos.map((p, i) => (
          <figure key={p.sha256}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/jpeg;base64,${p.jpegBase64}`} alt={`Proof photo ${i + 1}`} />
            <figcaption>
              {new Date(p.takenAtMs).toLocaleString()} · ±{Math.round(p.accuracyM)} m ·{' '}
              {formatKm(distanceKm(p, taskPoint))} from task ·{' '}
              <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">
                map
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
      <dl className="answers">
        {Object.entries(bundle.answers).map(([k, v]) => (
          <div key={k}>
            <dt>{ANSWER_LABELS[k] ?? k}</dt>
            <dd>{v || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
