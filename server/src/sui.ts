import { EnokiClient } from '@mysten/enoki';
import type { Signer } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { GRPC_URL, NETWORK } from '../../app/lib/config.ts';
import { sponsoredTargets } from '../../app/lib/tx.ts';
import { env } from './env.ts';

export const client = new SuiGrpcClient({ network: NETWORK, baseUrl: GRPC_URL });

let operatorKeypair: Ed25519Keypair | null = null;
export function operator(): Ed25519Keypair {
  operatorKeypair ??= Ed25519Keypair.fromSecretKey(env.operatorKey());
  return operatorKeypair;
}

const enoki = env.enokiPrivateKey && NETWORK !== 'localnet' ? new EnokiClient({ apiKey: env.enokiPrivateKey }) : null;

/**
 * Sign and execute as `signer`. With Enoki configured, gas is sponsored
 * (agent wallets then only need stablecoins); otherwise the signer pays gas.
 * Throws if the transaction fails on-chain.
 */
export async function execute(tx: Transaction, signer: Signer): Promise<string> {
  const sender = signer.toSuiAddress();
  tx.setSenderIfNotSet(sender);

  if (enoki && NETWORK !== 'localnet') {
    const kind = await tx.build({ client, onlyTransactionKind: true });
    const sponsored = await enoki.createSponsoredTransaction({
      network: NETWORK,
      transactionKindBytes: toBase64(kind),
      sender,
      allowedMoveCallTargets: sponsoredTargets(),
      allowedAddresses: [sender],
    });
    const { signature } = await signer.signTransaction(Uint8Array.from(Buffer.from(sponsored.bytes, 'base64')));
    const { digest } = await enoki.executeSponsoredTransaction({ digest: sponsored.digest, signature });
    const res = await client.core.waitForTransaction({ digest, include: { effects: true } });
    assertSuccess(res);
    return digest;
  }

  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  const done = res.Transaction ?? res.FailedTransaction;
  await client.core.waitForTransaction({ digest: done!.digest });
  if (res.$kind !== 'Transaction') {
    throw new Error(`Transaction failed: ${JSON.stringify(res.FailedTransaction?.effects?.status)}`);
  }
  return done!.digest;
}

function assertSuccess(res: unknown) {
  const r = res as { $kind?: string; FailedTransaction?: { effects?: { status?: unknown } } };
  if (r.$kind && r.$kind !== 'Transaction') {
    throw new Error(`Transaction failed: ${JSON.stringify(r.FailedTransaction?.effects?.status)}`);
  }
}
