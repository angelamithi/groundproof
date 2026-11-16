import { bcs } from '@mysten/sui/bcs';

// BCS layouts mirror the Move structs in the groundproof package.
// Field order matters: keep these in sync with sources/*.move.

const Table = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });

export const TaskBcs = bcs.struct('Task', {
  id: bcs.Address,
  requester: bcs.Address,
  kind: bcs.u8(),
  location_cell: bcs.string(),
  instructions: bcs.string(),
  reward: bcs.u64(),
  fee: bcs.u64(),
  slots: bcs.u64(),
  approved: bcs.u64(),
  active: bcs.u64(),
  deadline_ms: bcs.u64(),
  closed: bcs.bool(),
  escrow: bcs.u64(), // Balance<T> { value: u64 }
  claims: Table,
});

export const ClaimBcs = bcs.struct('Claim', {
  claimed_at_ms: bcs.u64(),
  status: bcs.u8(),
  proof_blob_id: bcs.string(),
  answer_hash: bcs.vector(bcs.u8()),
  captured_cell: bcs.string(),
  submitted_at_ms: bcs.u64(),
  rejected_at_ms: bcs.u64(),
  fraud_flag: bcs.bool(),
  votes_for_worker: bcs.u64(),
  votes_for_requester: bcs.u64(),
  voters: bcs.vector(bcs.Address),
});

export const RegistryBcs = bcs.struct('Registry', {
  id: bcs.Address,
  workers: Table,
  verifiers: Table,
});

export const StatsBcs = bcs.struct('Stats', {
  completed: bcs.u64(),
  rejected: bcs.u64(),
  strikes: bcs.u64(),
  banned: bcs.bool(),
});

export const ConfigBcs = bcs.struct('Config', {
  id: bcs.Address,
  fee_bps: bcs.u64(),
  treasury: bcs.Address,
  paused: bcs.bool(),
  claim_window_ms: bcs.u64(),
  auto_release_ms: bcs.u64(),
  dispute_window_ms: bcs.u64(),
  dispute_quorum: bcs.u64(),
});

export type PlatformConfig = {
  feeBps: number;
  paused: boolean;
  claimWindowMs: number;
  autoReleaseMs: number;
  disputeWindowMs: number;
};

export const TaskKind = { BusinessCheck: 0, PricePhoto: 1, Language: 2 } as const;

export const ClaimStatus = {
  Claimed: 0,
  Submitted: 1,
  Approved: 2,
  Rejected: 3,
  Expired: 4,
  PendingRejection: 5,
  Disputed: 6,
} as const;

export type Task = {
  id: string;
  coinType: string;
  requester: string;
  kind: number;
  locationCell: string;
  instructions: string;
  reward: bigint;
  slots: number;
  approved: number;
  active: number;
  openSlots: number;
  deadlineMs: number;
  closed: boolean;
  claimsTableId: string;
};

export type Claim = {
  worker: string;
  claimedAtMs: number;
  status: number;
  proofBlobId: string;
  answerHash: Uint8Array;
  capturedCell: string;
  submittedAtMs: number;
  rejectedAtMs: number;
  fraudFlag: boolean;
  votesForWorker: number;
  votesForRequester: number;
};

export type WorkerStats = {
  completed: number;
  rejected: number;
  strikes: number;
  banned: boolean;
  level: number;
};

/** Mirrors `reputation::level`. */
export function levelOf(s: Omit<WorkerStats, 'level'>): number {
  if (s.banned) return 0;
  if (s.completed >= 200 && s.strikes === 0) return 3;
  if (s.completed >= 50) return 2;
  if (s.completed >= 10) return 1;
  return 0;
}
