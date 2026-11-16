import type { SessionKey } from '@mysten/seal';
import { SessionKey as SK } from '@mysten/seal';
import { PACKAGE_ID } from '../../app/lib/config.ts';
import { openProof, verifyProof, type ProofBundle, type Verification } from '../../app/lib/proof.ts';
import type { Claim, Task } from '../../app/lib/types.ts';
import { client, operator } from './sui.ts';

// The operator is a registered verifier, so `task::seal_approve` lets it decrypt
// any proof. One Seal session is reused until it expires.
let session: SessionKey | null = null;
async function operatorSession(): Promise<SessionKey> {
  if (session && !session.isExpired()) return session;
  const signer = operator();
  session = await SK.create({
    address: signer.toSuiAddress(),
    packageId: PACKAGE_ID,
    ttlMin: 30,
    suiClient: client,
    signer,
  });
  return session;
}

export async function fetchProof(task: Task, claim: Claim): Promise<{ bundle: ProofBundle; integrity: Verification }> {
  const bundle = await openProof(client, task.id, task.coinType, claim.proofBlobId, operatorSession);
  const integrity = await verifyProof(bundle, task.id, claim.worker, claim.answerHash);
  return { bundle, integrity };
}
