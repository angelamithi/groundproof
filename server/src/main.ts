import { serve } from '@hono/node-server';
import { missingConfig } from '../../app/lib/config.ts';
import { app } from './api.ts';
import { env } from './env.ts';
import { pollOnce } from './indexer.ts';
import { runJobs } from './jobs.ts';
import { operator } from './sui.ts';

const missing = missingConfig().filter((m) => !m.includes('ENOKI_PUBLIC') && !m.includes('GOOGLE'));
if (missing.length) {
  console.error(`Missing configuration: ${missing.join(', ')}`);
  process.exit(1);
}
env.masterKey();
console.log(`Operator (must be a registered verifier): ${operator().toSuiAddress()}`);

serve({ fetch: app.fetch, port: env.port }, () => console.log(`Groundproof API on :${env.port}`));

let indexing = false;
setInterval(async () => {
  if (indexing) return;
  indexing = true;
  try {
    const n = await pollOnce();
    if (n) console.log(`indexed ${n} events`);
  } catch (e) {
    console.error('indexer error', (e as Error).message);
  } finally {
    indexing = false;
  }
}, env.indexerIntervalMs);

let working = false;
setInterval(async () => {
  if (working) return;
  working = true;
  try {
    const r = await runJobs();
    if (r.expired || r.finalized || r.rechecked) console.log('jobs', r);
  } catch (e) {
    console.error('jobs error', (e as Error).message);
  } finally {
    working = false;
  }
}, env.jobsIntervalMs);
