import { hmacHex } from './crypto.ts';
import { db } from './db.ts';

export type WebhookEvent =
  | 'submission.ready' // proof submitted and fraud-checked; ready for review
  | 'submission.paid'
  | 'submission.rejected'
  | 'dispute.opened'
  | 'dispute.resolved'
  | 'task.closed';

const MAX_ATTEMPTS = 8;

/** Queue an event for the API key that owns the task's wallet (if any). */
export function enqueueForWallet(wallet: string, event: WebhookEvent, data: Record<string, unknown>) {
  const key = db
    .prepare('SELECT id FROM api_keys WHERE wallet_address = ? AND webhook_url IS NOT NULL AND disabled = 0')
    .get(wallet) as { id: string } | undefined;
  if (!key) return;
  const payload = JSON.stringify({ event, created_at: new Date().toISOString(), data });
  db.prepare(
    'INSERT INTO webhook_deliveries(api_key_id, event, payload, next_attempt_at) VALUES (?, ?, ?, ?)',
  ).run(key.id, event, payload, Date.now());
}

/**
 * Deliver due webhooks. Each request is signed:
 *   X-Groundproof-Signature: sha256=HMAC_SHA256(webhook_secret, `${timestamp}.${body}`)
 * Receivers should recompute it and reject timestamps older than 5 minutes.
 */
export async function deliverDue() {
  const due = db
    .prepare(
      `SELECT d.id, d.event, d.payload, d.attempts, k.webhook_url, k.webhook_secret
       FROM webhook_deliveries d JOIN api_keys k ON k.id = d.api_key_id
       WHERE d.delivered_at IS NULL AND d.attempts < ? AND d.next_attempt_at <= ?
       ORDER BY d.id LIMIT 50`,
    )
    .all(MAX_ATTEMPTS, Date.now()) as {
    id: number;
    event: string;
    payload: string;
    attempts: number;
    webhook_url: string;
    webhook_secret: string;
  }[];

  for (const d of due) {
    const ts = Math.floor(Date.now() / 1000).toString();
    try {
      const res = await fetch(d.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-groundproof-event': d.event,
          'x-groundproof-timestamp': ts,
          'x-groundproof-signature': `sha256=${hmacHex(d.webhook_secret, `${ts}.${d.payload}`)}`,
        },
        body: d.payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      db.prepare('UPDATE webhook_deliveries SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?').run(
        Date.now(),
        d.id,
      );
    } catch (e) {
      const backoff = 30_000 * 2 ** d.attempts; // 30 s, 1 min, 2 min, …
      db.prepare(
        'UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?',
      ).run((e as Error).message, Date.now() + backoff, d.id);
    }
  }
}
