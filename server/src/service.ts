import { KIND_LABELS, parseLocation, toBaseUnits } from '../../app/lib/business.ts';
import { getEarningsBalance, getMyClaim, getPlatformConfig, getTask } from '../../app/lib/chain.ts';
import { COIN_DECIMALS, COIN_SYMBOL, COIN_TYPE, PACKAGE_ID } from '../../app/lib/config.ts';
import { approveTx, closeTx, createTasksTx, rejectTx, totalCost, type NewTask } from '../../app/lib/tx.ts';
import { ClaimStatus, TaskKind, type Task } from '../../app/lib/types.ts';
import { recordSpend, spentToday, type Account } from './accounts.ts';
import { db } from './db.ts';
import { saveTask } from './indexer.ts';
import { fetchProof } from './proofs.ts';
import { client, execute } from './sui.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const KINDS: Record<string, number> = {
  business_check: TaskKind.BusinessCheck,
  price_photo: TaskKind.PricePhoto,
  language: TaskKind.Language,
};
const KIND_NAMES = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));
const STATUS_NAMES: Record<number, string> = {
  [ClaimStatus.Claimed]: 'in_progress',
  [ClaimStatus.Submitted]: 'submitted',
  [ClaimStatus.Approved]: 'approved',
  [ClaimStatus.Rejected]: 'rejected',
  [ClaimStatus.Expired]: 'expired',
  [ClaimStatus.PendingRejection]: 'rejection_pending',
  [ClaimStatus.Disputed]: 'disputed',
};

export function usdc(raw: bigint | string): string {
  const v = BigInt(raw);
  const base = BigInt(10) ** BigInt(COIN_DECIMALS);
  const frac = (v % base).toString().padStart(COIN_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

export type PostTaskInput = {
  kind: string;
  location: string;
  instructions: string;
  reward_usdc: string | number;
  workers?: number;
  hours?: number;
};

/** Validate, enforce the key's limits, fund from the agent wallet and publish. */
export async function postTask(acc: Account, input: PostTaskInput) {
  const kind = KINDS[input.kind];
  if (kind === undefined) throw new ApiError(400, `kind must be one of ${Object.keys(KINDS).join(', ')}`);
  const cell = parseLocation(String(input.location ?? ''));
  if (!cell) throw new ApiError(400, 'location must be "lat, lng", a Google Maps link, or a geohash');
  const reward = toBaseUnits(String(input.reward_usdc));
  if (!reward || reward <= BigInt(0)) throw new ApiError(400, 'reward_usdc must be a positive amount');
  const workers = input.workers ?? 1;
  if (!Number.isInteger(workers) || workers < 1 || workers > 50) throw new ApiError(400, 'workers must be 1–50');
  const hours = input.hours ?? 48;
  if (!(hours > 0 && hours <= 24 * 90)) throw new ApiError(400, 'hours must be between 1 and 2160');
  const instructions = String(input.instructions ?? '').trim();
  if (instructions.length < 10 || instructions.length > 4000) {
    throw new ApiError(400, 'instructions must be 10–4000 characters');
  }

  if (reward > acc.maxReward) {
    throw new ApiError(403, `reward exceeds this key's limit of ${usdc(acc.maxReward)} ${COIN_SYMBOL} per worker`);
  }
  const cfg = await getPlatformConfig(client);
  if (cfg.paused) throw new ApiError(503, 'The platform is paused');
  const task: NewTask = { kind, locationCell: cell, instructions, reward, slots: workers, deadlineMs: Date.now() + hours * 3_600_000 };
  const cost = totalCost([task], cfg.feeBps);
  if (spentToday(acc) + cost > acc.dailyLimit) {
    throw new ApiError(403, `daily limit of ${usdc(acc.dailyLimit)} ${COIN_SYMBOL} would be exceeded`);
  }
  const balance = await getEarningsBalance(client, acc.walletAddress);
  if (balance < cost) {
    throw new ApiError(
      402,
      `insufficient balance: needs ${usdc(cost)} ${COIN_SYMBOL}, wallet ${acc.walletAddress} holds ${usdc(balance)}`,
    );
  }

  const digest = await execute(createTasksTx([task], COIN_TYPE, cfg.feeBps), acc.signer());
  recordSpend(acc, cost);
  const tx = await client.core.getTransaction({ digest, include: { events: true } });
  const created = (tx.Transaction?.events ?? []).find((e) => e.eventType.startsWith(`${PACKAGE_ID}::task::TaskCreated`));
  const taskId = (created?.json as { task_id?: string } | null)?.task_id;
  if (!taskId) throw new ApiError(500, `task created (tx ${digest}) but its id could not be read`);
  saveTask(await getTask(client, taskId));
  return { task_id: taskId, transaction: digest, escrowed_usdc: usdc(cost) };
}

async function ownedTask(acc: Account, taskId: string): Promise<Task> {
  let task: Task;
  try {
    task = await getTask(client, taskId);
  } catch {
    throw new ApiError(404, 'task not found');
  }
  if (task.requester.toLowerCase() !== acc.walletAddress.toLowerCase()) throw new ApiError(404, 'task not found');
  return task;
}

function checksFor(taskId: string) {
  const rows = db.prepare('SELECT worker, risk, verdict, flags FROM checks WHERE task_id = ?').all(taskId) as {
    worker: string;
    risk: number;
    verdict: string;
    flags: string;
  }[];
  return new Map(rows.map((r) => [r.worker, { risk: r.risk, verdict: r.verdict, flags: JSON.parse(r.flags) }]));
}

function taskSummary(t: Task) {
  return {
    task_id: t.id,
    kind: KIND_NAMES[t.kind],
    kind_label: KIND_LABELS[t.kind],
    location_cell: t.locationCell,
    instructions: t.instructions,
    reward_usdc: usdc(t.reward),
    workers: t.slots,
    approved: t.approved,
    in_progress: t.active,
    open_slots: t.openSlots,
    deadline: new Date(t.deadlineMs).toISOString(),
    closed: t.closed,
  };
}

export async function getTaskStatus(acc: Account, taskId: string) {
  const task = await ownedTask(acc, taskId);
  const checks = checksFor(task.id);
  const rows = db.prepare('SELECT worker FROM claims WHERE task_id = ?').all(task.id) as { worker: string }[];
  const submissions = [];
  for (const { worker } of rows) {
    const c = await getMyClaim(client, task, worker);
    if (!c) continue;
    submissions.push({
      worker,
      status: STATUS_NAMES[c.status] ?? String(c.status),
      submitted_at: c.submittedAtMs ? new Date(c.submittedAtMs).toISOString() : null,
      fraud_check: checks.get(worker) ?? null,
    });
  }
  return { ...taskSummary(task), submissions };
}

export function listTasks(acc: Account) {
  const rows = db
    .prepare('SELECT id FROM tasks WHERE lower(requester) = lower(?) ORDER BY deadline_ms DESC LIMIT 200')
    .all(acc.walletAddress) as { id: string }[];
  return Promise.all(rows.map(async (r) => taskSummary(await getTask(client, r.id))));
}

/** Decrypted answers and photo metadata for every submission on the task. */
export async function getResults(acc: Account, taskId: string, baseUrl: string) {
  const task = await ownedTask(acc, taskId);
  const checks = checksFor(task.id);
  const rows = db.prepare('SELECT worker FROM claims WHERE task_id = ?').all(task.id) as { worker: string }[];
  const results = [];
  for (const { worker } of rows) {
    const c = await getMyClaim(client, task, worker);
    if (!c?.proofBlobId) continue;
    const { bundle, integrity } = await fetchProof(task, c);
    results.push({
      worker,
      status: STATUS_NAMES[c.status],
      submitted_at: new Date(c.submittedAtMs).toISOString(),
      integrity_ok: integrity.ok,
      fraud_check: checks.get(worker) ?? null,
      answers: bundle.answers,
      photos: bundle.photos.map((p, i) => ({
        url: `${baseUrl}/v1/tasks/${task.id}/submissions/${worker}/photos/${i}`,
        sha256: p.sha256,
        lat: p.lat,
        lng: p.lng,
        accuracy_m: p.accuracyM,
        taken_at: new Date(p.takenAtMs).toISOString(),
      })),
    });
  }
  return { task_id: task.id, results };
}

export async function getPhoto(acc: Account, taskId: string, worker: string, index: number): Promise<Uint8Array> {
  const task = await ownedTask(acc, taskId);
  const c = await getMyClaim(client, task, worker);
  if (!c?.proofBlobId) throw new ApiError(404, 'no submission from this worker');
  const { bundle } = await fetchProof(task, c);
  const p = bundle.photos[index];
  if (!p) throw new ApiError(404, 'no such photo');
  return Uint8Array.from(Buffer.from(p.jpegBase64, 'base64'));
}

export async function approve(acc: Account, taskId: string, worker: string) {
  const task = await ownedTask(acc, taskId);
  const digest = await execute(approveTx(task.id, task.coinType, worker), acc.signer());
  return { transaction: digest, paid_usdc: usdc(task.reward) };
}

export async function reject(acc: Account, taskId: string, worker: string, fraud: boolean) {
  const task = await ownedTask(acc, taskId);
  const digest = await execute(rejectTx(task.id, task.coinType, worker, fraud), acc.signer());
  return { transaction: digest, note: 'The worker has 24 hours to dispute before the rejection is final.' };
}

export async function closeTask(acc: Account, taskId: string) {
  const task = await ownedTask(acc, taskId);
  if (task.closed) throw new ApiError(409, 'task already closed');
  const digest = await execute(closeTx(task.id, task.coinType), acc.signer());
  return { transaction: digest };
}

export async function accountInfo(acc: Account) {
  return {
    name: acc.name,
    wallet_address: acc.walletAddress,
    balance_usdc: usdc(await getEarningsBalance(client, acc.walletAddress)),
    coin_type: COIN_TYPE,
    limits: { max_reward_usdc: usdc(acc.maxReward), daily_limit_usdc: usdc(acc.dailyLimit) },
    spent_today_usdc: usdc(spentToday(acc)),
    webhook_url: acc.webhookUrl,
    top_up: `Send ${COIN_SYMBOL} to ${acc.walletAddress} to fund tasks.`,
  };
}
