// Server settings. The shared lib in ../app/lib reads the NEXT_PUBLIC_* values
// (package id, object ids, coin type, Walrus, Seal), so the server's .env uses
// the same names for those. Everything below is server-only.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  dbPath: process.env.DB_PATH ?? './groundproof.db',

  /** Platform operator key (suiprivkey…). Registered as a verifier so it can decrypt
   * proofs for fraud checks; also runs housekeeping (expire claims, finalize rejections). */
  operatorKey: () => required('OPERATOR_PRIVATE_KEY'),

  /** 32-byte hex key that encrypts agent wallet secrets at rest. */
  masterKey: () => required('MASTER_KEY'),

  /** Optional: Enoki private key to sponsor gas for agent wallets and the operator. */
  enokiPrivateKey: process.env.ENOKI_PRIVATE_KEY ?? '',

  /** Admin token for the /admin endpoints (at least 24 characters). */
  adminToken: process.env.ADMIN_TOKEN ?? '',

  indexerIntervalMs: Number(process.env.INDEXER_INTERVAL_MS ?? 4000),
  jobsIntervalMs: Number(process.env.JOBS_INTERVAL_MS ?? 60_000),
};
