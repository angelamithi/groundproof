import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.ts';

function key(): Buffer {
  const k = Buffer.from(env.masterKey(), 'hex');
  if (k.length !== 32) throw new Error('MASTER_KEY must be 32 bytes of hex (64 characters)');
  return k;
}

/** AES-256-GCM; output is iv.tag.ciphertext in base64. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function unseal(sealed: string): string {
  const [iv, tag, ct] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
