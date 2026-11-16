import { getMyClaim, getTask } from '../../app/lib/chain.ts';
import { PACKAGE_ID } from '../../app/lib/config.ts';
import { eventsClient } from '../../app/lib/events.ts';
import type { Claim, Task } from '../../app/lib/types.ts';
import { db, getMeta, setMeta } from './db.ts';
import { assess } from './fraud.ts';
import { fetchProof } from './proofs.ts';
import { client } from './sui.ts';
import { enqueueForWallet, type WebhookEvent } from './webhooks.ts';

const CURSOR_KEY = 'events_cursor';

export function saveTask(t: Task) {
  db.prepare(
    `INSERT INTO tasks(id, requester, coin_type, kind, location_cell, instructions, reward, slots, approved, active,
       deadline_ms, closed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET approved = excluded.approved, active = excluded.active,
       closed = excluded.closed, updated_at = excluded.updated_at`,
  ).run(
    t.id, t.requester, t.coinType, t.kind, t.locationCell, t.instructions, t.reward.toString(), t.slots,
    t.approved, t.active, t.deadlineMs, t.closed ? 1 : 0, Date.now(),
  );
}

function saveClaim(taskId: string, c: Claim) {
  db.prepare(
    `INSERT INTO claims(task_id, worker, status, claimed_at_ms, submitted_at_ms, rejected_at_ms, proof_blob_id,
       captured_cell, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, worker) DO UPDATE SET status = excluded.status, submitted_at_ms = excluded.submitted_at_ms,
       rejected_at_ms = excluded.rejected_at_ms, proof_blob_id = excluded.proof_blob_id,
       captured_cell = excluded.captured_cell, updated_at = excluded.updated_at`,
  ).run(taskId, c.worker, c.status, c.claimedAtMs, c.submittedAtMs, c.rejectedAtMs, c.proofBlobId, c.capturedCell, Date.now());
}

/** Decrypt a submission, run fraud checks, store the result. */
export async function checkSubmission(task: Task, claim: Claim) {
  try {
    const { bundle, integrity } = await fetchProof(task, claim);
    const result = assess(task, claim, bundle, integrity, {
      reusedElsewhere: (sha) =>
        (db
          .prepare('SELECT task_id, worker FROM photo_hashes WHERE sha256 = ? AND NOT (task_id = ? AND worker = ?)')
          .all(sha, task.id, claim.worker) as { task_id: string; worker: string }[]).map((r) => ({
          taskId: r.task_id,
          worker: r.worker,
        })),
      previousPhoto: (worker, beforeMs, excludeTask) => {
        const r = db
          .prepare(
            `SELECT lat, lng, taken_at_ms, task_id FROM photo_hashes
             WHERE worker = ? AND taken_at_ms < ? AND task_id != ? ORDER BY taken_at_ms DESC LIMIT 1`,
          )
          .get(worker, beforeMs, excludeTask) as
          | { lat: number; lng: number; taken_at_ms: number; task_id: string }
          | undefined;
        return r ? { lat: r.lat, lng: r.lng, takenAtMs: r.taken_at_ms, taskId: r.task_id } : null;
      },
    });
    const insertPhoto = db.prepare(
      'INSERT OR IGNORE INTO photo_hashes(sha256, task_id, worker, lat, lng, taken_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const p of bundle.photos) insertPhoto.run(p.sha256, task.id, claim.worker, p.lat, p.lng, p.takenAtMs);
    storeCheck(task.id, claim.worker, result.risk, result.verdict, result.flags);
    return result;
  } catch (e) {
    storeCheck(task.id, claim.worker, -1, 'error', [{ code: 'check_failed', detail: (e as Error).message, weight: 0 }]);
    return null;
  }
}

function storeCheck(taskId: string, worker: string, risk: number, verdict: string, flags: unknown) {
  db.prepare(
    `INSERT INTO checks(task_id, worker, risk, verdict, flags, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, worker) DO UPDATE SET risk = excluded.risk, verdict = excluded.verdict,
       flags = excluded.flags, checked_at = excluded.checked_at`,
  ).run(taskId, worker, risk, verdict, JSON.stringify(flags), Date.now());
}

const EVENT_WEBHOOK: Record<string, WebhookEvent> = {
  TaskPaid: 'submission.paid',
  RejectionFinal: 'submission.rejected',
  DisputeOpened: 'dispute.opened',
  DisputeResolved: 'dispute.resolved',
  TaskClosed: 'task.closed',
};

/** Read new events from the task module and bring the database up to date. */
export async function pollOnce(): Promise<number> {
  let cursor = getMeta(CURSOR_KEY);
  let processed = 0;
  for (;;) {
    const page = await eventsClient(client).core.listEvents({
      filter: { eventType: `${PACKAGE_ID}::task` },
      order: 'ascending',
      limit: 50,
      ...(cursor ? { after: cursor } : {}),
    });

    for (const e of page.events) {
      const name = e.eventType.split('::').pop()!.split('<')[0];
      const j = (e.json ?? {}) as Record<string, unknown>;
      const taskId = j.task_id as string | undefined;
      if (!taskId) continue;
      const task = await getTask(client, taskId);
      saveTask(task);
      const worker = j.worker as string | undefined;
      if (worker) {
        const claim = await getMyClaim(client, task, worker);
        if (claim) saveClaim(task.id, claim);
        if (name === 'ProofSubmitted' && claim) {
          const result = await checkSubmission(task, claim);
          enqueueForWallet(task.requester, 'submission.ready', {
            task_id: task.id,
            worker,
            risk: result?.risk ?? null,
            verdict: result?.verdict ?? 'error',
            flags: result?.flags ?? [],
          });
        }
      }
      const hook = EVENT_WEBHOOK[name];
      if (hook) enqueueForWallet(task.requester, hook, { task_id: task.id, worker: worker ?? null, ...j });
      processed++;
    }

    if (page.endCursor) {
      cursor = page.endCursor;
      setMeta(CURSOR_KEY, cursor);
    }
    if (!page.hasNextPage) break;
  }
  return processed;
}
