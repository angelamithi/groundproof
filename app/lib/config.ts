// All deployment-specific values come from environment variables.
// Copy .env.example to .env.local and fill them in after publishing the Move package.

export const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? 'testnet') as 'testnet' | 'mainnet' | 'localnet';

export const GRPC_URL =
  process.env.NEXT_PUBLIC_SUI_GRPC_URL ??
  {
    mainnet: 'https://fullnode.mainnet.sui.io:443',
    testnet: 'https://fullnode.testnet.sui.io:443',
    localnet: 'http://127.0.0.1:9000',
  }[NETWORK];

/**
 * Local development only: adds an in-browser test wallet and sends transactions
 * directly (user pays gas) instead of through Enoki. Never enable in production.
 */
export const DEV_WALLET = process.env.NEXT_PUBLIC_DEV_WALLET === 'true';

export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? '';
export const CONFIG_ID = process.env.NEXT_PUBLIC_CONFIG_ID ?? '';
export const REGISTRY_ID = process.env.NEXT_PUBLIC_REGISTRY_ID ?? '';

/** Stablecoin workers are paid in, e.g. testnet USDC. Used for the wallet balance. */
export const COIN_TYPE = process.env.NEXT_PUBLIC_COIN_TYPE ?? '';
export const COIN_DECIMALS = Number(process.env.NEXT_PUBLIC_COIN_DECIMALS ?? '6');
export const COIN_SYMBOL = process.env.NEXT_PUBLIC_COIN_SYMBOL ?? 'USDC';

export const ENOKI_PUBLIC_KEY = process.env.NEXT_PUBLIC_ENOKI_PUBLIC_KEY ?? '';
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

export const WALRUS_PUBLISHER =
  process.env.NEXT_PUBLIC_WALRUS_PUBLISHER ?? 'https://publisher.walrus-testnet.walrus.space';
export const WALRUS_AGGREGATOR =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? 'https://aggregator.walrus-testnet.walrus.space';
export const WALRUS_EPOCHS = Number(process.env.NEXT_PUBLIC_WALRUS_EPOCHS ?? '5');

/** Comma-separated Seal key server object ids for the chosen network. */
export const SEAL_KEY_SERVERS = (process.env.NEXT_PUBLIC_SEAL_KEY_SERVERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Development only: allow uploading proofs without Seal encryption. Never enable in production. */
export const ALLOW_UNENCRYPTED = process.env.NEXT_PUBLIC_ALLOW_UNENCRYPTED === 'true';

/** How far (km) the capture location may be from the task's location cell. */
export const MAX_DISTANCE_KM = Number(process.env.NEXT_PUBLIC_MAX_DISTANCE_KM ?? '1.5');

export const CLOCK_ID = '0x6';

/** Groundproof backend (fraud checks, agent API). Optional for the apps. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function missingConfig(): string[] {
  const required: Record<string, string> = {
    NEXT_PUBLIC_PACKAGE_ID: PACKAGE_ID,
    NEXT_PUBLIC_CONFIG_ID: CONFIG_ID,
    NEXT_PUBLIC_REGISTRY_ID: REGISTRY_ID,
    ...(DEV_WALLET
      ? {}
      : { NEXT_PUBLIC_ENOKI_PUBLIC_KEY: ENOKI_PUBLIC_KEY, NEXT_PUBLIC_GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID }),
  };
  return Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}
