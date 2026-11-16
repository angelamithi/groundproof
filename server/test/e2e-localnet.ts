// Backend end-to-end test against a local Sui network.
// Prereqs: `sui start --with-faucet --force-regenesis`, test USDC + groundproof published,
// walrus mock on :9300. Usage: npx tsx test/e2e-localnet.ts <ids.json> <admin suiprivkey file>
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const ids = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const adminKey = readFileSync(process.argv[3], 'utf8').trim();
const API = 'http://127.0.0.1:8787';
const sharedEnv = {
  NEXT_PUBLIC_SUI_NETWORK: 'localnet',
  NEXT_PUBLIC_PACKAGE_ID: ids.gp_pkg,
  NEXT_PUBLIC_CONFIG_ID: ids.config,
  NEXT_PUBLIC_REGISTRY_ID: ids.registry,
  NEXT_PUBLIC_COIN_TYPE: ids.usdc_type,
  NEXT_PUBLIC_WALRUS_PUBLISHER: 'http://127.0.0.1:9300',
  NEXT_PUBLIC_WALRUS_AGGREGATOR: 'http://127.0.0.1:9300',
  NEXT_PUBLIC_ALLOW_UNENCRYPTED: 'true',
};
Object.assign(process.env, sharedEnv);
const serverEnv = {
  ...process.env, ...sharedEnv,
  DB_PATH: '/tmp/gp-e2e.db', PORT: '8787', PUBLIC_URL: API,
  OPERATOR_PRIVATE_KEY: adminKey, MASTER_KEY: randomBytes(32).toString('hex'),
  INDEXER_INTERVAL_MS: '1000', JOBS_INTERVAL_MS: '3000',
};
for (const f of ['/tmp/gp-e2e.db', '/tmp/gp-e2e.db-wal', '/tmp/gp-e2e.db-shm']) rmSync(f, { force: true });

const { SuiGrpcClient } = await import('@mysten/sui/grpc');
const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
const { Transaction } = await import('@mysten/sui/transactions');
const { requestSuiFromFaucetV2 } = await import('@mysten/sui/faucet');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const txs = await import('../../app/lib/tx.ts');
const proof = await import('../../app/lib/proof.ts');
const chain = await import('../../app/lib/chain.ts');
const { encode } = await import('../../app/lib/geohash.ts');

const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000' });
const admin = Ed25519Keypair.fromSecretKey(adminKey);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
};
async function run(tx: InstanceType<typeof Transaction>, signer: InstanceType<typeof Ed25519Keypair>) {
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  await client.core.waitForTransaction({ digest: (res.Transaction ?? res.FailedTransaction)!.digest });
  if (res.$kind !== 'Transaction') throw new Error(JSON.stringify(res.FailedTransaction?.effects?.status));
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// --- Admin setup: operator is a verifier; short windows so jobs can be observed ---
console.log('Admin setup');
const setup = new Transaction();
setup.moveCall({ target: `${ids.gp_pkg}::reputation::add_verifier`,
  arguments: [setup.object(ids.admincap), setup.object(ids.registry), setup.pure.address(admin.toSuiAddress())] });
setup.moveCall({ target: `${ids.gp_pkg}::config::set_windows`,
  arguments: [setup.object(ids.admincap), setup.object(ids.config), setup.pure.u64(20_000), setup.pure.u64(48 * 3600_000)] });
setup.moveCall({ target: `${ids.gp_pkg}::config::set_dispute_rules`,
  arguments: [setup.object(ids.admincap), setup.object(ids.config), setup.pure.u64(6_000), setup.pure.u64(1)] });
await run(setup, admin);
assert(true, 'operator registered as verifier; claim window 20 s, dispute window 6 s');

// --- Webhook receiver that verifies signatures ---
const hooks: { event: string; data: any; validSig: boolean }[] = [];
let webhookSecret = '';
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ts = req.headers['x-groundproof-timestamp'] as string;
    const expected = 'sha256=' + createHmac('sha256', webhookSecret).update(`${ts}.${body}`).digest('hex');
    const parsed = JSON.parse(body);
    hooks.push({ event: parsed.event, data: parsed.data, validSig: req.headers['x-groundproof-signature'] === expected });
    res.writeHead(200).end('ok');
  });
}).listen(9400);

// --- API key via admin CLI ---
const cli = execFileSync('npx', ['tsx', 'src/cli.ts', 'create-key', 'Acme Research Agent', '--max-reward', '5', '--daily', '30',
  '--webhook', 'http://127.0.0.1:9400/hook'], { env: serverEnv, cwd: process.cwd() }).toString();
const key = JSON.parse(cli.slice(cli.indexOf('{'), cli.indexOf('}') + 1));
webhookSecret = key.webhookSecret;
assert(key.apiKey.startsWith('gp_live_') && key.walletAddress.startsWith('0x'), 'API key and agent wallet created');

// --- Start the server ---
const server = spawn('npx', ['tsx', 'src/main.ts'], { env: serverEnv, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const cleanup = () => { server.kill(); receiver.close(); };
process.on('exit', cleanup);
await waitFor('server', async () => (await fetch(`${API}/health`)).ok);
assert(true, 'server up');

try {
  const auth = { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' };
  const rest = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  assert((await fetch(`${API}/v1/account`)).status === 401, 'requests without a key are rejected (401)');

  // Fund the agent wallet: SUI for gas (no sponsorship on localnet) + 20 USDC
  await requestSuiFromFaucetV2({ host: 'http://127.0.0.1:9123', recipient: key.walletAddress });
  const mint = new Transaction();
  mint.moveCall({ target: '0x2::coin::mint_and_transfer', typeArguments: [ids.usdc_type],
    arguments: [mint.object(ids.cap), mint.pure.u64(20_000_000), mint.pure.address(key.walletAddress)] });
  await run(mint, admin);
  await sleep(1500);

  // --- AI agent over MCP ---
  console.log('AI agent via MCP');
  const mcp = new Client({ name: 'test-agent', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key.apiKey}` } } }));
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  assert(['post_task', 'get_task_status', 'get_result', 'approve_submission', 'reject_submission', 'close_task', 'list_tasks', 'get_account']
    .every((t) => tools.includes(t)), `MCP exposes 8 tools (${tools.join(', ')})`);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await mcp.callTool({ name, arguments: args });
    return { error: !!r.isError, data: JSON.parse(r.content[0].text) };
  };

  const account = await call('get_account');
  assert(account.data.balance_usdc === '20' && account.data.limits.max_reward_usdc === '5', 'get_account: 20 USDC, max reward 5');

  const tooBig = await call('post_task', { kind: 'business_check', location: '-1.2676, 36.8108', instructions: 'Check the pharmacy exists.', reward_usdc: '9' });
  assert(tooBig.error && /limit/.test(tooBig.data.error), 'reward above the key limit is refused');

  const posted = await call('post_task', {
    kind: 'business_check', location: 'https://maps.google.com/?q=-1.2676,36.8108',
    instructions: 'Confirm Goodlife Pharmacy on Westlands Road exists. Photograph sign and front; note hours.',
    reward_usdc: '2', workers: 3, hours: 24,
  });
  assert(!posted.error && posted.data.task_id && posted.data.escrowed_usdc === '6.3', `post_task created task, 6.3 USDC escrowed (${JSON.stringify(posted.data)})`);
  const taskId = posted.data.task_id as string;

  const overDaily = await call('post_task', { kind: 'price_photo', location: '-1.28, 36.82', instructions: 'Photograph milk and bread prices.', reward_usdc: '5', workers: 5 });
  assert(overDaily.error && /daily limit/.test(overDaily.data.error), 'daily spending limit enforced');

  // --- Workers ---
  console.log('Workers submit');
  const honest = new Ed25519Keypair(), cheat = new Ed25519Keypair(), noShow = new Ed25519Keypair();
  for (const w of [honest, cheat, noShow]) await requestSuiFromFaucetV2({ host: 'http://127.0.0.1:9123', recipient: w.toSuiAddress() });
  await sleep(2500);
  const task = await chain.getTask(client, taskId);
  for (const w of [honest, cheat, noShow]) {
    await run(txs.registerTx(), w);
    await run(txs.claimTx(task.id, task.coinType), w);
  }
  const jpeg = new Uint8Array([0xff, 0xd8, ...randomBytes(64), 0xff, 0xd9]);
  async function submit(w: InstanceType<typeof Ed25519Keypair>, lat: number, lng: number, answers: Record<string, string>) {
    const photo = { blob: new Blob([jpeg], { type: 'image/jpeg' }), lat, lng, accuracyM: 9, takenAtMs: Date.now() };
    const { bundle, answerHash } = await proof.buildBundle(task.id, w.toSuiAddress(), answers, [photo]);
    const blobId = await proof.encryptAndUpload(client, bundle);
    await run(txs.submitProofTx({ taskId: task.id, coinType: task.coinType, proofBlobId: blobId, answerHash, capturedCell: encode(lat, lng, 6) }), w);
  }
  await submit(honest, -1.2677, 36.8109, { exists: 'yes', signName: 'Goodlife Pharmacy', hours: '8am-9pm' });
  // The cheat reuses the honest worker's photo and is actually across town
  await submit(cheat, -1.3000, 36.8500, { exists: 'yes', signName: 'Goodlife', hours: '' });

  const status = await waitFor('fraud checks', async () => {
    const s = await call('get_task_status', { task_id: taskId });
    const subs = s.data.submissions ?? [];
    return subs.filter((x: any) => x.fraud_check).length >= 2 ? s.data : null;
  });
  const byWorker = (w: InstanceType<typeof Ed25519Keypair>) => status.submissions.find((x: any) => x.worker === w.toSuiAddress());
  const h = byWorker(honest), c = byWorker(cheat);
  assert(h.status === 'submitted' && h.fraud_check.verdict === 'ok', `honest worker: verdict ok, risk ${h.fraud_check.risk}`);
  const cheatCodes = c.fraud_check.flags.map((f: any) => f.code);
  assert(c.fraud_check.verdict === 'suspicious' && cheatCodes.includes('reused_photo') && cheatCodes.includes('too_far'),
    `cheater: suspicious, risk ${c.fraud_check.risk}, flags ${cheatCodes.join(', ')}`);
  assert(byWorker(noShow).status === 'in_progress', 'no-show worker still in progress');

  // --- Results via REST ---
  console.log('Results via REST');
  const results = await rest('GET', `/v1/tasks/${taskId}/results`);
  const hr = results.json.results.find((r: any) => r.worker === honest.toSuiAddress());
  assert(results.status === 200 && hr.integrity_ok && hr.answers.signName === 'Goodlife Pharmacy', 'results: decrypted answers, integrity ok');
  const img = await fetch(hr.photos[0].url, { headers: auth });
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert(img.headers.get('content-type') === 'image/jpeg' && Buffer.from(bytes).equals(Buffer.from(jpeg)), 'photo URL returns the exact JPEG');
  assert((await fetch(hr.photos[0].url)).status === 401, 'photo URL requires the API key');
  const pub = await (await fetch(`${API}/v1/checks/${taskId}`)).json();
  assert(pub.length === 2 && !JSON.stringify(pub).includes('Goodlife'), 'dashboard checks endpoint shows scores but no answers');

  const other = createKeyForStranger();
  assert((await fetch(`${API}/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${other}` } })).status === 404, "another key can't see this task");

  // --- Agent approves honest, rejects cheat as fraud ---
  console.log('Decisions');
  const appr = await call('approve_submission', { task_id: taskId, worker: honest.toSuiAddress() });
  assert(!appr.error && appr.data.paid_usdc === '2', 'approve_submission paid 2 USDC');
  assert((await chain.getEarningsBalance(client, honest.toSuiAddress())) === 2_000_000n, 'honest worker holds 2 USDC on-chain');
  const rej = await rest('POST', `/v1/tasks/${taskId}/reject`, { worker: cheat.toSuiAddress(), fraud: true });
  assert(rej.status === 200, 'REST reject as fraud');

  // --- Jobs: finalize rejection after dispute window, expire the no-show ---
  console.log('Background jobs');
  await waitFor('rejection finalized', async () => {
    const s = await call('get_task_status', { task_id: taskId });
    return s.data.submissions.find((x: any) => x.worker === cheat.toSuiAddress())?.status === 'rejected';
  });
  assert(true, 'job finalized the rejection after the dispute window');
  const reg = await chain.getWorkerStats(client, cheat.toSuiAddress());
  assert(reg?.strikes === 1, 'cheater received a fraud strike');
  await waitFor('claim expired', async () => {
    const s = await call('get_task_status', { task_id: taskId });
    return s.data.submissions.find((x: any) => x.worker === noShow.toSuiAddress())?.status === 'expired';
  }, 45000);
  assert(true, 'job expired the no-show claim after the claim window');

  // --- Close & refund ---
  const before = await chain.getEarningsBalance(client, key.walletAddress);
  const closed = await call('close_task', { task_id: taskId });
  assert(!closed.error, 'close_task');
  const refund = (await chain.getEarningsBalance(client, key.walletAddress)) - before;
  assert(refund === 2n * 2_100_000n, `2 unused slots refunded (${refund})`);
  const list = await call('list_tasks');
  assert(list.data.length === 1 && list.data[0].closed && list.data[0].approved === 1, 'list_tasks shows the closed task, 1 approved');

  // --- Webhooks ---
  console.log('Webhooks');
  await waitFor('webhooks', async () => hooks.some((x) => x.event === 'task.closed'), 30000);
  const events = hooks.map((x) => x.event);
  assert(hooks.every((x) => x.validSig), `all ${hooks.length} webhooks have valid signatures`);
  assert(events.filter((e) => e === 'submission.ready').length === 2, 'submission.ready sent for both submissions');
  const ready = hooks.find((x) => x.event === 'submission.ready' && x.data.worker === cheat.toSuiAddress());
  assert(ready?.data.verdict === 'suspicious', 'submission.ready carries the fraud verdict');
  for (const e of ['submission.paid', 'submission.rejected', 'task.closed']) assert(events.includes(e), `${e} webhook received`);

  console.log(`\nALL ${passed} BACKEND CHECKS PASSED`);
} catch (e) {
  console.error((e as Error).message);
  console.error('--- server log ---\n' + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}

function createKeyForStranger(): string {
  const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'create-key', 'Stranger'], { env: serverEnv, cwd: process.cwd() }).toString();
  return JSON.parse(out.slice(out.indexOf('{'), out.indexOf('}') + 1)).apiKey;
}
