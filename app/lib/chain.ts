import { bcs } from '@mysten/sui/bcs';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { COIN_TYPE, CONFIG_ID, PACKAGE_ID, REGISTRY_ID } from './config';
import {
  ConfigBcs,
  ClaimBcs,
  RegistryBcs,
  StatsBcs,
  TaskBcs,
  levelOf,
  type Claim,
  type PlatformConfig,
  type Task,
  type WorkerStats,
} from './types';

/** `0xpkg::task::Task<0xusdc::usdc::USDC>` -> `0xusdc::usdc::USDC` */
function coinTypeOf(objectType: string): string {
  const start = objectType.indexOf('<');
  return start < 0 ? '' : objectType.slice(start + 1, -1);
}

function toTask(objectType: string, content: Uint8Array): Task {
  const t = TaskBcs.parse(content);
  const slots = Number(t.slots);
  const approved = Number(t.approved);
  const active = Number(t.active);
  return {
    id: t.id,
    coinType: coinTypeOf(objectType),
    requester: t.requester,
    kind: t.kind,
    locationCell: t.location_cell,
    instructions: t.instructions,
    reward: BigInt(t.reward),
    slots,
    approved,
    active,
    openSlots: t.closed ? 0 : slots - approved - active,
    deadlineMs: Number(t.deadline_ms),
    closed: t.closed,
    claimsTableId: t.claims.id,
  };
}

export async function getTask(client: ClientWithCoreApi, id: string): Promise<Task> {
  const { object } = await client.core.getObject({ objectId: id, include: { content: true } });
  return toTask(object.type, object.content);
}

/** Recently created tasks that still have open slots and haven't expired. */
export async function listOpenTasks(client: ClientWithCoreApi): Promise<Task[]> {
  const { events } = await client.core.listEvents({
    filter: { eventType: `${PACKAGE_ID}::task::TaskCreated` },
    order: 'descending',
    limit: 50,
  });
  const ids = [
    ...new Set(
      events
        .map((e) => (e.json as { task_id?: string } | null)?.task_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  if (ids.length === 0) return [];
  const { objects } = await client.core.getObjects({ objectIds: ids, include: { content: true } });
  const now = Date.now();
  return objects
    .filter((o): o is Exclude<typeof o, Error> => !(o instanceof Error))
    .map((o) => toTask(o.type, o.content))
    .filter((t) => t.openSlots > 0 && t.deadlineMs > now);
}

function toClaim(worker: string, raw: Uint8Array): Claim {
  const c = ClaimBcs.parse(raw);
  return {
    worker,
    claimedAtMs: Number(c.claimed_at_ms),
    status: c.status,
    proofBlobId: c.proof_blob_id,
    answerHash: new Uint8Array(c.answer_hash),
    capturedCell: c.captured_cell,
    submittedAtMs: Number(c.submitted_at_ms),
    rejectedAtMs: Number(c.rejected_at_ms),
    fraudFlag: c.fraud_flag,
    votesForWorker: Number(c.votes_for_worker),
    votesForRequester: Number(c.votes_for_requester),
  };
}

function addressKey(address: string) {
  return { type: 'address', bcs: bcs.Address.serialize(address).toBytes() };
}

/** The current worker's claim on a task, or null if they haven't claimed it. */
export async function getMyClaim(
  client: ClientWithCoreApi,
  task: Task,
  worker: string,
): Promise<Claim | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: task.claimsTableId,
      name: addressKey(worker),
    });
    return toClaim(worker, dynamicField.value.bcs);
  } catch {
    return null;
  }
}

async function workersTableId(client: ClientWithCoreApi): Promise<string> {
  const { object } = await client.core.getObject({ objectId: REGISTRY_ID, include: { content: true } });
  return RegistryBcs.parse(object.content).workers.id;
}

/** Worker reputation, or null if the address hasn't registered yet. */
export async function getWorkerStats(client: ClientWithCoreApi, worker: string): Promise<WorkerStats | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: await workersTableId(client),
      name: addressKey(worker),
    });
    const s = StatsBcs.parse(dynamicField.value.bcs);
    const stats = {
      completed: Number(s.completed),
      rejected: Number(s.rejected),
      strikes: Number(s.strikes),
      banned: s.banned,
    };
    return { ...stats, level: levelOf(stats) };
  } catch {
    return null;
  }
}

export async function getEarningsBalance(client: ClientWithCoreApi, owner: string): Promise<bigint> {
  if (!COIN_TYPE) return BigInt(0);
  const { balance } = await client.core.getBalance({ owner, coinType: COIN_TYPE });
  return BigInt(balance.balance);
}

export async function getPlatformConfig(client: ClientWithCoreApi): Promise<PlatformConfig> {
  const { object } = await client.core.getObject({ objectId: CONFIG_ID, include: { content: true } });
  const c = ConfigBcs.parse(object.content);
  return {
    feeBps: Number(c.fee_bps),
    paused: c.paused,
    claimWindowMs: Number(c.claim_window_ms),
    autoReleaseMs: Number(c.auto_release_ms),
    disputeWindowMs: Number(c.dispute_window_ms),
  };
}

/** Tasks created by this business, newest first. */
export async function listMyTasks(client: ClientWithCoreApi, requester: string): Promise<Task[]> {
  const ids: string[] = [];
  let before: string | null = null;
  for (let page = 0; page < 5; page++) {
    const res = await client.core.listEvents({
      filter: { eventType: `${PACKAGE_ID}::task::TaskCreated` },
      order: 'descending',
      limit: 50,
      ...(before ? { before } : {}),
    });
    for (const e of res.events) {
      const j = e.json as { task_id?: string; requester?: string } | null;
      if (j?.task_id && j.requester && normalize(j.requester) === normalize(requester)) ids.push(j.task_id);
    }
    if (!res.hasNextPage || !res.endCursor) break;
    before = res.endCursor;
  }
  if (ids.length === 0) return [];
  const { objects } = await client.core.getObjects({ objectIds: [...new Set(ids)], include: { content: true } });
  return objects
    .filter((o): o is Exclude<typeof o, Error> => !(o instanceof Error))
    .map((o) => toTask(o.type, o.content));
}

/** Every worker's claim on a task. */
export async function listClaims(client: ClientWithCoreApi, task: Task): Promise<Claim[]> {
  const claims: Claim[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.core.listDynamicFields({ parentId: task.claimsTableId, cursor, limit: 50 });
    for (const f of page.dynamicFields) {
      const worker = bcs.Address.parse(f.name.bcs);
      const { dynamicField } = await client.core.getDynamicField({ parentId: task.claimsTableId, name: f.name });
      claims.push(toClaim(worker, dynamicField.value.bcs));
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return claims.sort((a, b) => b.claimedAtMs - a.claimedAtMs);
}

function normalize(address: string): string {
  return address.toLowerCase().replace(/^0x0*/, '0x');
}
