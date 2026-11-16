'use client';

import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatAmount } from '@/components/format';
import { SignIn } from '@/components/SignIn';
import {
  CSV_TEMPLATE,
  KIND_LABELS,
  downloadText,
  parseLocation,
  tasksFromCsv,
  toBaseUnits,
} from '@/lib/business';
import { getEarningsBalance, getPlatformConfig } from '@/lib/chain';
import { COIN_TYPE } from '@/lib/config';
import { useSponsoredExecute } from '@/lib/hooks';
import { createTasksTx, feeFor, totalCost, type NewTask } from '@/lib/tx';

/** Tasks per transaction when bulk-creating from CSV. */
const BATCH = 20;

export default function NewTaskPage() {
  const account = useCurrentAccount();
  if (!account) return <SignIn title="Groundproof for Business" tagline="Sign in to post tasks." />;
  return <NewTask address={account.address} />;
}

function NewTask({ address }: { address: string }) {
  const client = useCurrentClient();
  const router = useRouter();
  const execute = useSponsoredExecute();
  const config = useQuery({ queryKey: ['config'], queryFn: () => getPlatformConfig(client) });
  const balance = useQuery({ queryKey: ['balance', address], queryFn: () => getEarningsBalance(client, address) });
  const feeBps = config.data?.feeBps ?? 0;

  // Single task form
  const [kind, setKind] = useState(0);
  const [location, setLocation] = useState('');
  const [instructions, setInstructions] = useState('');
  const [reward, setReward] = useState('2.00');
  const [workers, setWorkers] = useState('1');
  const [hours, setHours] = useState('48');

  // CSV
  const [csvTasks, setCsvTasks] = useState<NewTask[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cell = parseLocation(location);
  const rewardUnits = toBaseUnits(reward);
  const slots = Number(workers);
  const formTask: NewTask | null =
    cell && rewardUnits && rewardUnits > BigInt(0) && Number.isInteger(slots) && slots >= 1 && Number(hours) > 0 && instructions.trim()
      ? {
          kind,
          locationCell: cell,
          instructions: instructions.trim(),
          reward: rewardUnits,
          slots,
          deadlineMs: Date.now() + Number(hours) * 3_600_000,
        }
      : null;

  async function create(tasks: NewTask[]) {
    setError(null);
    if (!COIN_TYPE) return setError('NEXT_PUBLIC_COIN_TYPE is not configured.');
    const cost = totalCost(tasks, feeBps);
    if (balance.data !== undefined && balance.data < cost) {
      return setError(`Not enough balance: this needs ${formatAmount(cost)}, you have ${formatAmount(balance.data)}.`);
    }
    try {
      for (let i = 0; i < tasks.length; i += BATCH) {
        setBusy(`Creating ${Math.min(i + BATCH, tasks.length)} of ${tasks.length}…`);
        await execute(createTasksTx(tasks.slice(i, i + BATCH), COIN_TYPE, feeBps));
      }
      router.push('/business');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="wide">
      <h2>New task</h2>
      <div className="grid2">
        <div className="card">
          <label>Task type</label>
          <select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
            {KIND_LABELS.map((l, i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
          </select>

          <label>Location (coordinates or Google Maps link)</label>
          <input
            placeholder="-1.2676, 36.8108"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          {location && !cell && <p className="error small">Couldn't read that location.</p>}
          {cell && (
            <p className="muted small">
              Area code {cell} (about 1 km). The exact place goes in the instructions.
            </p>
          )}

          <label>Instructions for the worker</label>
          <textarea
            rows={5}
            placeholder="e.g. Go to Goodlife Pharmacy, Westlands Road. Photograph the sign, the front and inside. Note opening hours."
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <p className="muted small">Instructions are public on-chain. Don't include personal data.</p>

          <div className="grid2">
            <div>
              <label>Reward per worker (USDC)</label>
              <input inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} />
            </div>
            <div>
              <label>Number of workers</label>
              <input inputMode="numeric" value={workers} onChange={(e) => setWorkers(e.target.value)} />
            </div>
          </div>
          <label>Deadline (hours from now)</label>
          <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
          <p className="muted small">Use 2–3 workers for important checks so answers can be cross-checked.</p>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Cost</h3>
          {formTask ? (
            <table className="table">
              <tbody>
                <tr>
                  <td>Rewards ({formTask.slots} × {formatAmount(formTask.reward)})</td>
                  <td>{formatAmount(formTask.reward * BigInt(formTask.slots))}</td>
                </tr>
                <tr>
                  <td>Platform fee ({feeBps / 100}%)</td>
                  <td>{formatAmount(feeFor(formTask.reward, feeBps) * BigInt(formTask.slots))}</td>
                </tr>
                <tr>
                  <td>
                    <strong>Total held in escrow</strong>
                  </td>
                  <td>
                    <strong>{formatAmount(totalCost([formTask], feeBps))}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted">Fill in the form to see the cost.</p>
          )}
          <p className="muted small">
            You only pay for approved work. Unused slots are refunded when you close the task. Balance:{' '}
            {balance.data !== undefined ? formatAmount(balance.data) : '…'}
          </p>
          <button className="primary" disabled={!formTask || !!busy || !config.data} onClick={() => create([formTask!])}>
            {busy ?? 'Fund and publish task'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <h3 style={{ margin: 0 }}>Bulk upload (CSV)</h3>
          <button className="link" onClick={() => downloadText('groundproof-template.csv', CSV_TEMPLATE)}>
            Download template
          </button>
        </div>
        <p className="muted small">
          Columns: kind (business_check, price_photo, language), location, reward_usdc, workers, hours, instructions.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const { tasks, errors } = tasksFromCsv(await file.text());
            setCsvTasks(tasks);
            setCsvErrors(errors);
          }}
        />
        {csvErrors.length > 0 && (
          <ul className="error small">
            {csvErrors.slice(0, 20).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {csvTasks.length > 0 && (
          <>
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Area</th>
                  <th>Reward</th>
                  <th>Workers</th>
                  <th>Instructions</th>
                </tr>
              </thead>
              <tbody>
                {csvTasks.slice(0, 50).map((t, i) => (
                  <tr key={i}>
                    <td>{KIND_LABELS[t.kind]}</td>
                    <td>{t.locationCell}</td>
                    <td>{formatAmount(t.reward)}</td>
                    <td>{t.slots}</td>
                    <td className="small">{t.instructions.slice(0, 60)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {csvTasks.length > 50 && <p className="muted small">…and {csvTasks.length - 50} more</p>}
            <p>
              <strong>{csvTasks.length} tasks</strong>, total held in escrow{' '}
              <strong>{formatAmount(totalCost(csvTasks, feeBps))}</strong>
            </p>
            <button
              className="primary"
              disabled={!!busy || csvErrors.length > 0 || !config.data}
              onClick={() => create(csvTasks)}
            >
              {busy ?? `Fund and publish ${csvTasks.length} tasks`}
            </button>
            {csvErrors.length > 0 && <p className="muted small">Fix the rows above first.</p>}
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
