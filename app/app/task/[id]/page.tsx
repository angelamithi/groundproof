'use client';

import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Camera } from '@/components/Camera';
import { formatAmount, formatKm, formatTimeLeft } from '@/components/format';
import { SignIn } from '@/components/SignIn';
import { getMyClaim, getPlatformConfig, getTask } from '@/lib/chain';
import { MAX_DISTANCE_KM } from '@/lib/config';
import { decode, distanceKm, encode } from '@/lib/geohash';
import { usePosition, useSponsoredExecute } from '@/lib/hooks';
import { useT, type Key } from '@/lib/i18n';
import { buildBundle, encryptAndUpload, type CapturedPhoto } from '@/lib/proof';
import { acceptRejectionTx, autoReleaseTx, claimTx, disputeTx, submitProofTx } from '@/lib/tx';
import { ClaimStatus, TaskKind, type Task } from '@/lib/types';

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const { pos } = usePosition();

  const task = useQuery({ queryKey: ['task', id], queryFn: () => getTask(client, id) });
  const claim = useQuery({
    queryKey: ['claim', id, account?.address],
    queryFn: () => getMyClaim(client, task.data!, account!.address),
    enabled: !!task.data && !!account,
  });
  const config = useQuery({ queryKey: ['config'], queryFn: () => getPlatformConfig(client) });

  if (!account) return <SignIn />;
  if (task.isLoading || claim.isLoading) return <div className="center muted">…</div>;
  if (task.error) return <p className="error">{(task.error as Error).message}</p>;
  const tk = task.data!;
  const km = pos ? distanceKm(pos, decode(tk.locationCell)) : null;
  const c = claim.data;
  const now = Date.now();

  return (
    <section>
      <div className="card">
        <div className="row">
          <h2>{t(`kind${tk.kind}` as Key)}</h2>
          <span className="pay">{formatAmount(tk.reward)}</span>
        </div>
        <p className="muted small">
          {km === null ? '' : `${formatKm(km)} ${t('away')} · `}
          {t('deadline')}: {formatTimeLeft(tk.deadlineMs)}
        </p>
        <h3>{t('instructions')}</h3>
        <p className="instructions">{tk.instructions}</p>
      </div>

      {!c && <ClaimButton task={tk} />}

      {c?.status === ClaimStatus.Claimed && <CaptureAndSubmit task={tk} />}

      {c?.status === ClaimStatus.Submitted && (
        <div className="card">
          <p>{t('submitted')}</p>
          {config.data && now > c.submittedAtMs + config.data.autoReleaseMs && (
            <>
              <p className="muted small">{t('collectHint')}</p>
              <ActionButton label={t('collect')} build={() => autoReleaseTx(tk.id, tk.coinType)} />
            </>
          )}
        </div>
      )}

      {c?.status === ClaimStatus.PendingRejection && (
        <div className="card">
          <p className="warn">{t('rejectedPending')}</p>
          {config.data && now <= c.rejectedAtMs + config.data.disputeWindowMs && (
            <ActionButton label={t('dispute')} build={() => disputeTx(tk.id, tk.coinType)} />
          )}
          <ActionButton
            label={t('accept')}
            secondary
            build={() => acceptRejectionTx(tk.id, tk.coinType, account.address)}
          />
        </div>
      )}

      {c?.status === ClaimStatus.Disputed && <p className="card">{t('disputed')}</p>}
      {c?.status === ClaimStatus.Approved && <p className="card ok">{t('approved')}</p>}
      {c?.status === ClaimStatus.Rejected && <p className="card error">{t('rejected')}</p>}
      {c?.status === ClaimStatus.Expired && <p className="card muted">{t('expired')}</p>}
    </section>
  );
}

function ActionButton({
  label,
  build,
  secondary,
}: {
  label: string;
  build: () => import('@mysten/sui/transactions').Transaction;
  secondary?: boolean;
}) {
  const execute = useSponsoredExecute();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className={secondary ? 'secondary' : 'primary'}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await execute(build());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '…' : label}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function ClaimButton({ task }: { task: Task }) {
  const { t } = useT();
  if (task.openSlots <= 0) return null;
  return (
    <div className="card">
      <ActionButton label={t('claim')} build={() => claimTx(task.id, task.coinType)} />
    </div>
  );
}

function CaptureAndSubmit({ task }: { task: Task }) {
  const { t } = useT();
  const client = useCurrentClient();
  const account = useCurrentAccount()!;
  const execute = useSponsoredExecute();
  const { pos } = usePosition();
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setAnswers({ ...answers, [k]: e.target.value });

  async function submit() {
    setError(null);
    if (photos.length === 0 && task.kind !== TaskKind.Language) return setError(t('needPhoto'));
    const where = photos[0] ?? pos;
    if (!where) return setError(t('locating'));
    if (task.kind !== TaskKind.Language && distanceKm(where, decode(task.locationCell)) > MAX_DISTANCE_KM) {
      return setError(t('tooFar'));
    }
    setBusy(true);
    try {
      const { bundle, answerHash } = await buildBundle(task.id, account.address, answers, photos);
      const blobId = await encryptAndUpload(client, bundle);
      await execute(
        submitProofTx({
          taskId: task.id,
          coinType: task.coinType,
          proofBlobId: blobId,
          answerHash,
          capturedCell: encode(where.lat, where.lng, 6),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <p className="muted small">{t('claimedHint')}</p>
      {task.kind !== TaskKind.Language && <Camera position={pos} photos={photos} onChange={setPhotos} />}

      {task.kind === TaskKind.BusinessCheck && (
        <>
          <label>{t('businessExists')}</label>
          <select value={answers.exists ?? ''} onChange={set('exists')}>
            <option value="" disabled>
              —
            </option>
            <option value="yes">{t('yes')}</option>
            <option value="no">{t('no')}</option>
          </select>
          <label>{t('businessName')}</label>
          <input value={answers.signName ?? ''} onChange={set('signName')} />
          <label>{t('openingHours')}</label>
          <input value={answers.hours ?? ''} onChange={set('hours')} />
        </>
      )}

      {task.kind === TaskKind.PricePhoto && (
        <>
          <label>{t('prices')}</label>
          <textarea rows={5} value={answers.prices ?? ''} onChange={set('prices')} />
        </>
      )}

      {task.kind === TaskKind.Language && (
        <>
          <label>{t('answer')}</label>
          <textarea rows={6} value={answers.answer ?? ''} onChange={set('answer')} />
        </>
      )}

      <label>{t('notes')}</label>
      <textarea rows={2} value={answers.notes ?? ''} onChange={set('notes')} />

      <button className="primary big" disabled={busy} onClick={submit}>
        {busy ? t('submitting') : t('submit')}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
