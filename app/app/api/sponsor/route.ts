import { NextResponse } from 'next/server';
import { NETWORK } from '@/lib/config';
import { enoki } from '@/lib/enoki-server';
import { sponsoredTargets } from '@/lib/tx';

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/**
 * Ask Enoki to pay gas for a worker's transaction. Only Groundproof's own
 * worker functions are allowed, so the sponsor budget can't be drained.
 * TODO before mainnet: rate-limit per address and verify the caller's session.
 */
export async function POST(req: Request) {
  try {
    const { transactionKindBytes, sender, recipient } = (await req.json()) as {
      transactionKindBytes?: string;
      sender?: string;
      /** Only for withdrawals: the outside address the funds go to. */
      recipient?: string;
    };
    if (recipient !== undefined && !SUI_ADDRESS.test(recipient)) {
      return NextResponse.json({ error: 'recipient must be a full 0x… Sui address' }, { status: 400 });
    }
    if (!transactionKindBytes || !sender) {
      return NextResponse.json({ error: 'transactionKindBytes and sender are required' }, { status: 400 });
    }
    if (NETWORK === 'localnet') {
      return NextResponse.json({ error: 'Sponsorship is not available on localnet' }, { status: 400 });
    }
    const sponsored = await enoki().createSponsoredTransaction({
      network: NETWORK,
      transactionKindBytes,
      sender,
      allowedMoveCallTargets: sponsoredTargets(),
      allowedAddresses: recipient ? [sender, recipient] : [sender],
    });
    return NextResponse.json({ bytes: sponsored.bytes, digest: sponsored.digest });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
