import { getMyClaim, getPlatformConfig, getTask } from '../../app/lib/chain.ts';
import { acceptRejectionTx, expireClaimTx } from '../../app/lib/tx.ts';
import { ClaimStatus } from '../../app/lib/types.ts';
import { db } from './db.ts';
import { checkSubmission } from './indexer.ts';
import { client, execute, operator } from './sui.ts';
import { deliverDue } from './webhooks.ts';

type Row = { task_id: string; worker: string; coin_type: string };

/**
 * Housekeeping that keeps tasks moving without anyone pressing buttons:
 * - free slots whose worker never submitted (expire_claim),
 * - finalize rejections once the dispute window has passed,
 * - retry fraud checks that failed (e.g. storage briefly unreachable),
 * - deliver webhooks.
 */
export async function runJobs(): Promise<{ expired: number; finalized: number; rechecked: number }> {
  const cfg = await getPlatformConfig(client);
  const now = Date.now();
  let expired = 0;
  let finalized = 0;
  let rechecked = 0;

  const stale = db
    .prepare(
      `SELECT c.task_id, c.worker, t.coin_type FROM claims c JOIN tasks t ON t.id = c.task_id
       WHERE c.status = ? AND c.claimed_at_ms + ? < ? LIMIT 20`,
    )
    .all(ClaimStatus.Claimed, cfg.claimWindowMs, now) as Row[];
  for (const r of stale) {
    try {
      await execute(expireClaimTx(r.task_id, r.coin_type, r.worker), operator());
      expired++;
    } catch (e) {
      console.warn('expire_claim failed', r.task_id, (e as Error).message);
    }
  }

  const pending = db
    .prepare(
      `SELECT c.task_id, c.worker, t.coin_type FROM claims c JOIN tasks t ON t.id = c.task_id
       WHERE c.status = ? AND c.rejected_at_ms + ? < ? LIMIT 20`,
    )
    .all(ClaimStatus.PendingRejection, cfg.disputeWindowMs, now) as Row[];
  for (const r of pending) {
    try {
      await execute(acceptRejectionTx(r.task_id, r.coin_type, r.worker), operator());
      finalized++;
    } catch (e) {
      console.warn('finalize_rejection failed', r.task_id, (e as Error).message);
    }
  }

  const failed = db
    .prepare(
      `SELECT k.task_id, k.worker FROM checks k JOIN claims c ON c.task_id = k.task_id AND c.worker = k.worker
       WHERE k.verdict = 'error' AND c.status IN (?, ?, ?) AND k.checked_at < ? LIMIT 10`,
    )
    .all(ClaimStatus.Submitted, ClaimStatus.PendingRejection, ClaimStatus.Disputed, now - 5 * 60_000) as {
    task_id: string;
    worker: string;
  }[];
  for (const r of failed) {
    const task = await getTask(client, r.task_id);
    const claim = await getMyClaim(client, task, r.worker);
    if (claim) {
      await checkSubmission(task, claim);
      rechecked++;
    }
  }

  await deliverDue();
  return { expired, finalized, rechecked };
}
