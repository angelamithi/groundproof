import { DatabaseSync } from 'node:sqlite';
import { env } from './env.ts';

export const db = new DatabaseSync(env.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Latest known state of each task (refreshed from chain on every event).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  coin_type TEXT NOT NULL,
  kind INTEGER NOT NULL,
  location_cell TEXT NOT NULL,
  instructions TEXT NOT NULL,
  reward TEXT NOT NULL,
  slots INTEGER NOT NULL,
  approved INTEGER NOT NULL,
  active INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_requester ON tasks(requester);

CREATE TABLE IF NOT EXISTS claims (
  task_id TEXT NOT NULL,
  worker TEXT NOT NULL,
  status INTEGER NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  submitted_at_ms INTEGER NOT NULL,
  rejected_at_ms INTEGER NOT NULL,
  proof_blob_id TEXT NOT NULL,
  captured_cell TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, worker)
);
CREATE INDEX IF NOT EXISTS claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS claims_worker ON claims(worker);

-- Result of automated fraud checks on a submission.
CREATE TABLE IF NOT EXISTS checks (
  task_id TEXT NOT NULL,
  worker TEXT NOT NULL,
  risk INTEGER NOT NULL,            -- 0 (clean) .. 100 (almost certainly fake)
  verdict TEXT NOT NULL,            -- ok | review | suspicious | error
  flags TEXT NOT NULL,              -- JSON array of { code, detail, weight }
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, worker)
);

-- Every photo hash ever submitted, to catch reused photos.
CREATE TABLE IF NOT EXISTS photo_hashes (
  sha256 TEXT NOT NULL,
  task_id TEXT NOT NULL,
  worker TEXT NOT NULL,
  lat REAL, lng REAL, taken_at_ms INTEGER,
  PRIMARY KEY (sha256, task_id, worker)
);
CREATE INDEX IF NOT EXISTS photo_worker_time ON photo_hashes(worker, taken_at_ms);

-- API keys for businesses and AI agents. Each key has its own Sui wallet
-- (secret encrypted with MASTER_KEY) that funds and owns its tasks.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL,
  wallet_secret_enc TEXT NOT NULL,
  max_reward TEXT NOT NULL,         -- per worker, base units
  daily_limit TEXT NOT NULL,        -- total escrow per UTC day, base units
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (
  api_key_id TEXT NOT NULL,
  day TEXT NOT NULL,
  amount TEXT NOT NULL,
  PRIMARY KEY (api_key_id, day)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL
);
`);

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}
