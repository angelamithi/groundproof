import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';

type Signer = (bytes: string) => Promise<{ signature: string }>;

/**
 * Run a transaction with gas paid by Groundproof (Enoki sponsorship):
 * 1. build only the transaction kind (no gas),
 * 2. our server asks Enoki to sponsor it,
 * 3. the worker signs the sponsored bytes,
 * 4. our server submits it through Enoki.
 */
export async function executeSponsored(
  client: ClientWithCoreApi,
  tx: Transaction,
  sender: string,
  sign: Signer,
  recipient?: string,
): Promise<string> {
  // The sender is needed to resolve stablecoin payments (coinWithBalance).
  tx.setSenderIfNotSet(sender);
  const kindBytes = await tx.build({ client, onlyTransactionKind: true });

  const sponsorRes = await fetch('/api/sponsor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactionKindBytes: toBase64(kindBytes), sender, recipient }),
  });
  if (!sponsorRes.ok) throw new Error(`Sponsor failed: ${await sponsorRes.text()}`);
  const { bytes, digest } = (await sponsorRes.json()) as { bytes: string; digest: string };

  const { signature } = await sign(bytes);

  const execRes = await fetch('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ digest, signature }),
  });
  if (!execRes.ok) throw new Error(`Execute failed: ${await execRes.text()}`);
  const result = (await execRes.json()) as { digest: string };

  // Wait until the fullnode has the effects so the UI reads fresh state.
  await client.core.waitForTransaction({ digest: result.digest });
  return result.digest;
}
