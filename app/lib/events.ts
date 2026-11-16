import type { ClientWithCoreApi } from '@mysten/sui/client';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { NETWORK } from './config';

// Public fullnodes prune old history, so an event search that starts from the
// beginning of the chain fails with "requested data below earliest available".
// Sui's GraphQL service is backed by an indexer with full history, so event
// lookups go there on testnet and mainnet. Localnet keeps everything, so the
// normal client is fine there.

const GRAPHQL_URL =
  process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL ??
  (NETWORK === 'mainnet' ? 'https://graphql.mainnet.sui.io/graphql' : 'https://graphql.testnet.sui.io/graphql');

let graphql: SuiGraphQLClient | null = null;

/** The client to use for `core.listEvents`. */
export function eventsClient(fallback: ClientWithCoreApi): ClientWithCoreApi {
  if (NETWORK === 'localnet') return fallback;
  graphql ??= new SuiGraphQLClient({ url: GRAPHQL_URL, network: NETWORK });
  return graphql;
}
