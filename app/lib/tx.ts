import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { CLOCK_ID, CONFIG_ID, PACKAGE_ID, REGISTRY_ID } from './config';

// Transaction builders for every worker and business action.
// All of them can be sponsored, so nobody needs SUI for gas.

export function registerTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${PACKAGE_ID}::reputation::register`, arguments: [tx.object(REGISTRY_ID)] });
  return tx;
}

export function claimTx(taskId: string, coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::claim`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId), tx.object(CONFIG_ID), tx.object(REGISTRY_ID), tx.object(CLOCK_ID)],
  });
  return tx;
}

export function submitProofTx(args: {
  taskId: string;
  coinType: string;
  proofBlobId: string;
  answerHash: Uint8Array;
  capturedCell: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::submit_proof`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.taskId),
      tx.object(CONFIG_ID),
      tx.pure.string(args.proofBlobId),
      tx.pure.vector('u8', Array.from(args.answerHash)),
      tx.pure.string(args.capturedCell),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export function autoReleaseTx(taskId: string, coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::auto_release`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId), tx.object(CONFIG_ID), tx.object(REGISTRY_ID), tx.object(CLOCK_ID)],
  });
  return tx;
}

export function disputeTx(taskId: string, coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::dispute`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId), tx.object(CONFIG_ID), tx.object(CLOCK_ID)],
  });
  return tx;
}

export function acceptRejectionTx(taskId: string, coinType: string, worker: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::finalize_rejection`,
    typeArguments: [coinType],
    arguments: [
      tx.object(taskId),
      tx.object(CONFIG_ID),
      tx.object(REGISTRY_ID),
      tx.pure.address(worker),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/** Move call targets the sponsor endpoint is allowed to pay gas for. */
export function sponsoredTargets(): string[] {
  return [
    `${PACKAGE_ID}::task::create`,
    `${PACKAGE_ID}::task::approve`,
    `${PACKAGE_ID}::task::reject`,
    `${PACKAGE_ID}::task::close`,
    `${PACKAGE_ID}::reputation::register`,
    `${PACKAGE_ID}::task::claim`,
    `${PACKAGE_ID}::task::submit_proof`,
    `${PACKAGE_ID}::task::auto_release`,
    `${PACKAGE_ID}::task::dispute`,
    `${PACKAGE_ID}::task::finalize_rejection`,
    `${PACKAGE_ID}::task::expire_claim`,
  ];
}

// === Business (requester) actions ===

export type NewTask = {
  kind: number;
  locationCell: string;
  instructions: string;
  /** Reward per worker, in the coin's smallest unit. */
  reward: bigint;
  slots: number;
  deadlineMs: number;
};

/** Fee the contract will charge per slot, mirroring `config::fee_for`. */
export function feeFor(reward: bigint, feeBps: number): bigint {
  return (reward * BigInt(feeBps)) / BigInt(10_000);
}

export function totalCost(tasks: NewTask[], feeBps: number): bigint {
  return tasks.reduce((sum, t) => sum + BigInt(t.slots) * (t.reward + feeFor(t.reward, feeBps)), BigInt(0));
}

/**
 * Create one or many tasks in a single transaction, each funded from the
 * business's stablecoin balance (never from the gas coin, so it works sponsored).
 */
export function createTasksTx(tasks: NewTask[], coinType: string, feeBps: number): Transaction {
  const tx = new Transaction();
  for (const t of tasks) {
    const payment = coinWithBalance({
      type: coinType,
      balance: BigInt(t.slots) * (t.reward + feeFor(t.reward, feeBps)),
      useGasCoin: false,
    });
    tx.moveCall({
      target: `${PACKAGE_ID}::task::create`,
      typeArguments: [coinType],
      arguments: [
        tx.object(CONFIG_ID),
        payment,
        tx.pure.u8(t.kind),
        tx.pure.string(t.locationCell),
        tx.pure.string(t.instructions),
        tx.pure.u64(t.reward),
        tx.pure.u64(t.slots),
        tx.pure.u64(t.deadlineMs),
        tx.object(CLOCK_ID),
      ],
    });
  }
  return tx;
}

export function approveTx(taskId: string, coinType: string, worker: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::approve`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId), tx.object(CONFIG_ID), tx.object(REGISTRY_ID), tx.pure.address(worker)],
  });
  return tx;
}

export function rejectTx(taskId: string, coinType: string, worker: string, fraud: boolean): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::reject`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId), tx.pure.address(worker), tx.pure.bool(fraud), tx.object(CLOCK_ID)],
  });
  return tx;
}

export function closeTx(taskId: string, coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::close`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId)],
  });
  return tx;
}

/** Transaction kind that Seal key servers dry-run to check decrypt access. */
export function sealApproveTx(taskId: string, coinType: string, sealId: Uint8Array): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::seal_approve`,
    typeArguments: [coinType],
    arguments: [tx.pure.vector('u8', Array.from(sealId)), tx.object(taskId), tx.object(REGISTRY_ID)],
  });
  return tx;
}

/** Free a slot whose worker never submitted in time. Anyone may call this. */
export function expireClaimTx(taskId: string, coinType: string, worker: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::task::expire_claim`,
    typeArguments: [coinType],
    arguments: [tx.object(taskId), tx.object(CONFIG_ID), tx.pure.address(worker), tx.object(CLOCK_ID)],
  });
  return tx;
}
