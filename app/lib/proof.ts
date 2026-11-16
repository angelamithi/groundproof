import { EncryptedObject, SealClient, SessionKey } from '@mysten/seal';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { fromBase64, fromHex, toHex } from '@mysten/sui/utils';
import {
  ALLOW_UNENCRYPTED,
  PACKAGE_ID,
  SEAL_KEY_SERVERS,
  WALRUS_AGGREGATOR,
  WALRUS_EPOCHS,
  WALRUS_PUBLISHER,
} from './config';
import { sealApproveTx } from './tx';

export type CapturedPhoto = {
  blob: Blob;
  lat: number;
  lng: number;
  accuracyM: number;
  takenAtMs: number;
};

export type ProofBundle = {
  version: 1;
  taskId: string;
  worker: string;
  answers: Record<string, string>;
  photos: { sha256: string; lat: number; lng: number; accuracyM: number; takenAtMs: number; jpegBase64: string }[];
  userAgent: string;
  createdAtMs: number;
};

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Canonical JSON (sorted keys) so the same answers always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The on-chain hash commits to the answers and to each photo's hash and metadata. */
function commitmentOf(
  taskId: string,
  worker: string,
  answers: Record<string, string>,
  photos: ProofBundle['photos'],
): string {
  return canonical({
    taskId,
    worker,
    answers,
    photos: photos.map(({ jpegBase64: _omit, ...meta }) => meta),
  });
}

export async function buildBundle(
  taskId: string,
  worker: string,
  answers: Record<string, string>,
  photos: CapturedPhoto[],
): Promise<{ bundle: ProofBundle; answerHash: Uint8Array }> {
  const encoded = await Promise.all(
    photos.map(async (p) => {
      const bytes = new Uint8Array(await p.blob.arrayBuffer());
      return {
        sha256: toHex(await sha256(bytes)),
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        takenAtMs: p.takenAtMs,
        jpegBase64: bytesToBase64(bytes),
      };
    }),
  );
  const commitment = commitmentOf(taskId, worker, answers, encoded);
  return {
    bundle: {
      version: 1,
      taskId,
      worker,
      answers,
      photos: encoded,
      userAgent: navigator.userAgent,
      createdAtMs: Date.now(),
    },
    answerHash: await sha256(commitment),
  };
}

/**
 * Encrypt with Seal so only the task's requester can decrypt
 * (enforced on-chain by `task::seal_approve`). The Seal identity is
 * `task id bytes || random nonce`.
 */
function sealClient(client: ClientWithCoreApi): SealClient {
  return new SealClient({
    suiClient: client,
    serverConfigs: SEAL_KEY_SERVERS.map((objectId) => ({ objectId, weight: 1 })),
    verifyKeyServers: false,
  });
}

async function encrypt(client: ClientWithCoreApi, taskId: string, data: Uint8Array): Promise<Uint8Array> {
  if (SEAL_KEY_SERVERS.length === 0) {
    if (ALLOW_UNENCRYPTED) return data;
    throw new Error('No Seal key servers configured (NEXT_PUBLIC_SEAL_KEY_SERVERS).');
  }
  const seal = sealClient(client);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const id = toHex(new Uint8Array([...fromHex(taskId), ...nonce]));
  const { encryptedObject } = await seal.encrypt({
    threshold: Math.min(2, SEAL_KEY_SERVERS.length),
    packageId: PACKAGE_ID,
    id,
    data,
  });
  return encryptedObject;
}

/** Store bytes on Walrus through an HTTP publisher; returns the blob id. */
async function uploadToWalrus(data: Uint8Array): Promise<string> {
  const res = await fetch(`${WALRUS_PUBLISHER}/v1/blobs?epochs=${WALRUS_EPOCHS}`, {
    method: 'PUT',
    body: data as BodyInit,
  });
  if (!res.ok) throw new Error(`Walrus upload failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    newlyCreated?: { blobObject: { blobId: string } };
    alreadyCertified?: { blobId: string };
  };
  const blobId = json.newlyCreated?.blobObject.blobId ?? json.alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus response had no blob id');
  return blobId;
}

export async function encryptAndUpload(
  client: ClientWithCoreApi,
  bundle: ProofBundle,
): Promise<string> {
  const plain = new TextEncoder().encode(JSON.stringify(bundle));
  const sealed = await encrypt(client, bundle.taskId, plain);
  return uploadToWalrus(sealed);
}

// === Business side: fetch, decrypt and verify a proof ===

export async function downloadFromWalrus(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`);
  if (!res.ok) throw new Error(`Walrus download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function tryParsePlain(data: Uint8Array): ProofBundle | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as ProofBundle;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** A short-lived Seal session, signed once by the business's wallet. */
export async function createSealSession(
  client: ClientWithCoreApi,
  address: string,
  signPersonalMessage: (message: Uint8Array) => Promise<string>,
): Promise<SessionKey> {
  const session = await SessionKey.create({ address, packageId: PACKAGE_ID, ttlMin: 30, suiClient: client });
  await session.setPersonalMessageSignature(await signPersonalMessage(session.getPersonalMessage()));
  return session;
}

/**
 * Download and decrypt a proof. Seal key servers only release keys if
 * `task::seal_approve` succeeds, i.e. the caller is the task's requester.
 */
export async function openProof(
  client: ClientWithCoreApi,
  taskId: string,
  coinType: string,
  blobId: string,
  getSession: () => Promise<SessionKey>,
): Promise<ProofBundle> {
  const data = await downloadFromWalrus(blobId);
  if (ALLOW_UNENCRYPTED) {
    const plain = tryParsePlain(data);
    if (plain) return plain;
  }
  const { id } = EncryptedObject.parse(data);
  const txBytes = await sealApproveTx(taskId, coinType, fromHex(id)).build({ client, onlyTransactionKind: true });
  const plain = await sealClient(client).decrypt({ data, sessionKey: await getSession(), txBytes });
  const bundle = tryParsePlain(plain);
  if (!bundle) throw new Error('Decrypted proof is not a valid bundle');
  return bundle;
}

export type Verification = { ok: boolean; problems: string[] };

/**
 * Check the bundle against what the worker committed to on-chain: the
 * answers and photo metadata must hash to the on-chain value, and every photo
 * must match its recorded SHA-256. Any edit after submission is detected.
 */
export async function verifyProof(
  bundle: ProofBundle,
  taskId: string,
  worker: string,
  onchainHash: Uint8Array,
): Promise<Verification> {
  const problems: string[] = [];
  if (bundle.taskId !== taskId) problems.push('Proof is for a different task');
  if (bundle.worker.toLowerCase() !== worker.toLowerCase()) problems.push('Proof is from a different worker');
  const hash = await sha256(commitmentOf(bundle.taskId, bundle.worker, bundle.answers, bundle.photos));
  if (toHex(hash) !== toHex(onchainHash)) problems.push('Answers or photo details changed after submission');
  for (const [i, p] of bundle.photos.entries()) {
    if (toHex(await sha256(fromBase64(p.jpegBase64))) !== p.sha256) problems.push(`Photo ${i + 1} was altered`);
  }
  return { ok: problems.length === 0, problems };
}
