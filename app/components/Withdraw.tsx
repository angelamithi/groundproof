'use client';

import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useState } from 'react';
import { toBaseUnits } from '@/lib/business';
import { COIN_DECIMALS, COIN_TYPE, NETWORK } from '@/lib/config';
import { useSponsoredExecute } from '@/lib/hooks';
import { useT } from '@/lib/i18n';
import { withdrawTx } from '@/lib/tx';
import { formatAmount } from './format';

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/** Send stablecoin out of the Groundproof wallet, gas-free. */
export function Withdraw({ balance }: { balance: bigint }) {
  const { t } = useT();
  const account = useCurrentAccount()!;
  const execute = useSponsoredExecute();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  const recipient = to.trim();
  const units = toBaseUnits(amount);
  const addressError = recipient && !SUI_ADDRESS.test(recipient)
    ? t('badAddress')
    : recipient.toLowerCase() === account.address.toLowerCase()
      ? t('ownAddress')
      : null;
  const amountOk = !!units && units > BigInt(0) && units <= balance;
  const canReview = !!recipient && !addressError && amountOk;

  function maxAmount() {
    const base = BigInt(10) ** BigInt(COIN_DECIMALS);
    const whole = balance / base;
    const frac = (balance % base).toString().padStart(COIN_DECIMALS, '0').replace(/0+$/, '');
    setAmount(frac ? `${whole}.${frac}` : `${whole}`);
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const d = await execute(withdrawTx(COIN_TYPE, units!, recipient), { recipient });
      setDigest(d);
      setReviewing(false);
      setConfirmed(false);
      setAmount('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (balance <= BigInt(0) && !digest) return null;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{t('withdraw')}</h3>
      <p className="muted small">{t('withdrawHint')}</p>

      {digest && (
        <p className="ok small">
          {t('sent')}{' '}
          <a href={`https://suiscan.xyz/${NETWORK}/tx/${digest}`} target="_blank" rel="noreferrer">
            {t('viewTx')}
          </a>
        </p>
      )}

      {!reviewing ? (
        <>
          <label>{t('toAddress')}</label>
          <input
            className="mono"
            placeholder="0x…"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {addressError && <p className="error small">{addressError}</p>}

          <label>{t('amount')}</label>
          <div className="row">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="secondary" style={{ width: 'auto', marginTop: 0 }} onClick={maxAmount}>
              {t('max')}
            </button>
          </div>
          {amount && !amountOk && <p className="error small">{t('badAmount')}</p>}

          <button className="primary" disabled={!canReview} onClick={() => setReviewing(true)}>
            {t('review')}
          </button>
        </>
      ) : (
        <>
          <p>
            {t('youSend')} <strong>{formatAmount(units!)}</strong> {t('to')}{' '}
            <span className="mono">{short(recipient)}</span>
          </p>
          <p className="mono small muted" style={{ wordBreak: 'break-all' }}>
            {recipient}
          </p>
          <label className="row" style={{ alignItems: 'flex-start', gap: 8, color: 'var(--ink)' }}>
            <input
              type="checkbox"
              style={{ width: 'auto', marginTop: 3 }}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span className="small">{t('checkNetwork')}</span>
          </label>
          <p className="muted small">{t('noFees')}</p>
          <button className="primary" disabled={!confirmed || busy} onClick={send}>
            {busy ? t('sending') : t('confirmSend')}
          </button>
          <button className="secondary" disabled={busy} onClick={() => setReviewing(false)}>
            {t('cancel')}
          </button>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
