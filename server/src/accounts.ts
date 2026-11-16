import { randomUUID } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBaseUnits } from '../../app/lib/business.ts';
import { randomToken, seal, sha256Hex, unseal } from './crypto.ts';
import { db } from './db.ts';

/**
 * An API key belongs to a business or AI agent. Each key gets its own Sui
 * wallet: the customer tops it up with USDC, and tasks posted through the API
 * are funded from (and owned by) that wallet. Spending limits cap the damage
 * if a key leaks or an agent misbehaves.
 */
export type Account = {
  id: string;
  name: string;
  walletAddress: string;
  maxReward: bigint;
  dailyLimit: bigint;
  webhookUrl: string | null;
  signer: () => Ed25519Keypair;
};

type Row = {
  id: string;
  name: string;
  wallet_address: string;
  wallet_secret_enc: string;
  max_reward: string;
  daily_limit: string;
  webhook_url: string | null;
  disabled: number;
};

function toAccount(r: Row): Account {
  return {
    id: r.id,
    name: r.name,
    walletAddress: r.wallet_address,
    maxReward: BigInt(r.max_reward),
    dailyLimit: BigInt(r.daily_limit),
    webhookUrl: r.webhook_url,
    signer: () => Ed25519Keypair.fromSecretKey(unseal(r.wallet_secret_enc)),
  };
}

export function createApiKey(opts: {
  name: string;
  maxRewardUsdc?: string;
  dailyLimitUsdc?: string;
  webhookUrl?: string;
}) {
  const id = randomUUID();
  const apiKey = randomToken('gp_live');
  const webhookSecret = randomToken('whsec');
  const wallet = new Ed25519Keypair();
  const maxReward = toBaseUnits(opts.maxRewardUsdc ?? '20');
  const dailyLimit = toBaseUnits(opts.dailyLimitUsdc ?? '200');
  if (!maxReward || !dailyLimit) throw new Error('Invalid limits');
  db.prepare(
    `INSERT INTO api_keys(id, name, key_hash, wallet_address, wallet_secret_enc, max_reward, daily_limit,
       webhook_url, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.name,
    sha256Hex(apiKey),
    wallet.toSuiAddress(),
    seal(wallet.getSecretKey()),
    maxReward.toString(),
    dailyLimit.toString(),
    opts.webhookUrl ?? null,
    webhookSecret,
    Date.now(),
  );
  return { id, apiKey, walletAddress: wallet.toSuiAddress(), webhookSecret };
}

export function authenticate(header: string | undefined | null): Account | null {
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const r = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND disabled = 0').get(sha256Hex(token)) as
    | Row
    | undefined;
  return r ? toAccount(r) : null;
}

export function listApiKeys() {
  return db
    .prepare('SELECT id, name, wallet_address, max_reward, daily_limit, webhook_url, disabled, created_at FROM api_keys')
    .all();
}

export function setWebhook(id: string, url: string | null) {
  db.prepare('UPDATE api_keys SET webhook_url = ? WHERE id = ?').run(url, id);
}

export function disableKey(id: string) {
  db.prepare('UPDATE api_keys SET disabled = 1 WHERE id = ?').run(id);
}

const today = () => new Date().toISOString().slice(0, 10);

export function spentToday(acc: Account): bigint {
  const r = db.prepare('SELECT amount FROM spend WHERE api_key_id = ? AND day = ?').get(acc.id, today()) as
    | { amount: string }
    | undefined;
  return BigInt(r?.amount ?? '0');
}

export function recordSpend(acc: Account, amount: bigint) {
  const total = spentToday(acc) + amount;
  db.prepare(
    'INSERT INTO spend(api_key_id, day, amount) VALUES (?, ?, ?) ON CONFLICT(api_key_id, day) DO UPDATE SET amount = excluded.amount',
  ).run(acc.id, today(), total.toString());
}
