import { createDAppKit } from '@mysten/dapp-kit-react';
import { enokiWalletsInitializer } from '@mysten/enoki';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { DEV_WALLET, ENOKI_PUBLIC_KEY, GOOGLE_CLIENT_ID, GRPC_URL, NETWORK } from './config';

/**
 * dApp Kit with Enoki "Sign in with Google" (zkLogin) as the only wallet.
 * Workers never see a seed phrase; their Sui address comes from their Google login.
 * Created in the browser only (see app/providers.tsx).
 */
export function makeDAppKit() {
  return createDAppKit({
    networks: [NETWORK],
    defaultNetwork: NETWORK,
    createClient: (network) => new SuiGrpcClient({ network, baseUrl: GRPC_URL }),
    slushWalletConfig: null,
    enableBurnerWallet: DEV_WALLET,
    walletInitializers: !ENOKI_PUBLIC_KEY
      ? []
      : [
      enokiWalletsInitializer({
        apiKey: ENOKI_PUBLIC_KEY,
        providers: {
          google: {
            clientId: GOOGLE_CLIENT_ID,
            redirectUrl: typeof window !== 'undefined' ? `${window.location.origin}/auth` : undefined,
          },
        },
      }),
        ],
  });
}

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: ReturnType<typeof makeDAppKit>;
  }
}
