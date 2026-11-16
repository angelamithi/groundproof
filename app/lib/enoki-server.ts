import 'server-only';
import { EnokiClient } from '@mysten/enoki';

let client: EnokiClient | null = null;

/** Server-side Enoki client. The private key must never reach the browser. */
export function enoki(): EnokiClient {
  const apiKey = process.env.ENOKI_PRIVATE_KEY;
  if (!apiKey) throw new Error('ENOKI_PRIVATE_KEY is not set');
  client ??= new EnokiClient({ apiKey });
  return client;
}
