'use client';

import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import type { Transaction } from '@mysten/sui/transactions';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { getWorkerStats } from './chain';
import { DEV_WALLET } from './config';
import { executeSponsored } from './sponsor';

/** Run a gas-free transaction as the signed-in worker. */
export function useSponsoredExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const queryClient = useQueryClient();

  return useCallback(
    async (tx: Transaction, opts?: { recipient?: string }) => {
      if (!account) throw new Error('Not signed in');
      if (DEV_WALLET) {
        // Local development: the test wallet pays its own gas.
        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        const done = result.Transaction ?? result.FailedTransaction;
        if (!result.Transaction) throw new Error(`Transaction failed: ${JSON.stringify(done?.effects?.status)}`);
        await client.core.waitForTransaction({ digest: done!.digest });
        await queryClient.invalidateQueries();
        return done!.digest;
      }
      const digest = await executeSponsored(
        client,
        tx,
        account.address,
        async (bytes) => {
          const signed = await dAppKit.signTransaction({ transaction: bytes });
          return { signature: signed.signature };
        },
        opts?.recipient,
      );
      await queryClient.invalidateQueries();
      return digest;
    },
    [account, client, dAppKit, queryClient],
  );
}

export function useWorkerStats() {
  const client = useCurrentClient();
  const account = useCurrentAccount();
  return useQuery({
    queryKey: ['stats', account?.address],
    queryFn: () => getWorkerStats(client, account!.address),
    enabled: !!account,
  });
}

export type Position = { lat: number; lng: number; accuracyM: number };

/** Live device position (high accuracy). */
export function usePosition() {
  const [pos, setPos] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('unsupported');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      (e) => setError(e.message),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return { pos, error };
}
