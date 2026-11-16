// End-to-end check of the business dashboard's code against a local Sui network.
// Usage: npx tsx scripts/e2e-business-localnet.mts <ids.json> <admin suiprivkey>
// ids.json: { gp_pkg, config, registry, usdc_type, cap }  (admin = publisher, holds the USDC TreasuryCap)
import { readFileSync } from 'node:fs';
const ids = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const adminKey = readFileSync(process.argv[3], 'utf8').trim();
Object.assign(process.env, {
  NEXT_PUBLIC_PACKAGE_ID: ids.gp_pkg,
  NEXT_PUBLIC_CONFIG_ID: ids.config,
  NEXT_PUBLIC_REGISTRY_ID: ids.registry,
  NEXT_PUBLIC_COIN_TYPE: ids.usdc_type,
});
const { SuiGrpcClient } = await import('@mysten/sui/grpc');
const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
const { Transaction } = await import('@mysten/sui/transactions');
const { requestSuiFromFaucetV2 } = await import('@mysten/sui/faucet');
const chain = await import('../lib/chain.ts');
const txs = await import('../lib/tx.ts');
const biz = await import('../lib/business.ts');
const proof = await import('../lib/proof.ts');
const { ClaimStatus } = await import('../lib/types.ts');

const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000' });
const admin = Ed25519Keypair.fromSecretKey(adminKey);
const business = new Ed25519Keypair(), worker = new Ed25519Keypair();
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };

for (const kp of [business, worker])
  await requestSuiFromFaucetV2({ host: 'http://127.0.0.1:9123', recipient: kp.toSuiAddress() });
await new Promise((r) => setTimeout(r, 3000));

async function run(tx: InstanceType<typeof Transaction>, signer: InstanceType<typeof Ed25519Keypair>, label: string) {
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  const done = res.Transaction ?? res.FailedTransaction;
  await client.core.waitForTransaction({ digest: done!.digest });
  if (res.$kind !== 'Transaction') throw new Error(`${label} failed: ${JSON.stringify(res.FailedTransaction?.effects?.status)}`);
  console.log(`✓ ${label}`);
}
const usdc = (owner: string) => chain.getEarningsBalance(client, owner);

// Admin mints 100 test USDC to the business
const mint = new Transaction();
mint.moveCall({ target: '0x2::coin::mint_and_transfer', typeArguments: [ids.usdc_type],
  arguments: [mint.object(ids.cap), mint.pure.u64(100_000_000), mint.pure.address(business.toSuiAddress())] });
await run(mint, admin, 'mint 100 USDC to business');
assert((await usdc(business.toSuiAddress())) === 100_000_000n, 'business holds 100 USDC');

// --- CSV import (dashboard bulk upload) ---
const csv = biz.CSV_TEMPLATE + 'language,"https://www.google.com/maps/@-1.2921,36.8219,15z",1.50,2,24,"Record 20 Sheng phrases with translations"\n';
const parsed = biz.tasksFromCsv(csv);
assert(parsed.errors.length === 0 && parsed.tasks.length === 3, `CSV parsed 3 tasks (${parsed.errors.join('; ')})`);
assert(biz.parseLocation('https://maps.google.com/?q=-1.2676,36.8108') === parsed.tasks[0].locationCell, 'maps link and coordinates give the same area');
assert(biz.tasksFromCsv('kind,location\nx,y').errors.length === 1, 'CSV with missing columns is rejected');
const cfg = await chain.getPlatformConfig(client);
const cost = txs.totalCost(parsed.tasks, cfg.feeBps);
// 2.00*1 + 0.80*3 + 1.50*2 = 7.40 USDC rewards, +5% fee = 7.77
assert(cost === 7_770_000n, `total cost incl. 5% fee = 7.77 USDC (got ${cost})`);

await run(txs.createTasksTx(parsed.tasks, ids.usdc_type, cfg.feeBps), business, 'create 3 tasks in one transaction (paid in USDC)');
assert((await usdc(business.toSuiAddress())) === 100_000_000n - cost, 'business USDC reduced by exactly the cost');

const mine = await chain.listMyTasks(client, business.toSuiAddress());
assert(mine.length === 3, 'dashboard lists the business\'s 3 tasks');
assert((await chain.listMyTasks(client, worker.toSuiAddress())).length === 0, 'other accounts see none of them');
const shop = mine.find((t) => t.kind === 0)!;
const prices = mine.find((t) => t.kind === 1)!;

// --- Worker does the shop check with a real proof bundle ---
await run(txs.registerTx(), worker, 'worker registers');
await run(txs.claimTx(shop.id, shop.coinType), worker, 'worker claims shop check');
const photo = { blob: new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])], { type: 'image/jpeg' }),
  lat: -1.2677, lng: 36.8109, accuracyM: 12, takenAtMs: Date.now() };
const answers = { exists: 'yes', signName: 'Goodlife Pharmacy', hours: '8am-9pm', notes: '' };
const { bundle, answerHash } = await proof.buildBundle(shop.id, worker.toSuiAddress(), answers, [photo]);
await run(txs.submitProofTx({ taskId: shop.id, coinType: shop.coinType, proofBlobId: 'local-test-blob',
  answerHash, capturedCell: shop.locationCell }), worker, 'worker submits proof');

// --- Business reviews ---
const claims = await chain.listClaims(client, await chain.getTask(client, shop.id));
assert(claims.length === 1 && claims[0].status === ClaimStatus.Submitted, 'dashboard shows 1 submission needing review');
assert(claims[0].worker === worker.toSuiAddress(), 'submission attributed to the right worker');
const good = await proof.verifyProof(bundle, shop.id, worker.toSuiAddress(), claims[0].answerHash);
assert(good.ok, 'untouched proof matches the on-chain record');
const tampered = structuredClone(bundle); tampered.answers.exists = 'no';
assert(!(await proof.verifyProof(tampered, shop.id, worker.toSuiAddress(), claims[0].answerHash)).ok, 'edited answers are detected');
const swapped = structuredClone(bundle); swapped.photos[0].jpegBase64 = btoa('fake');
assert(!(await proof.verifyProof(swapped, shop.id, worker.toSuiAddress(), claims[0].answerHash)).ok, 'swapped photo is detected');

const adminBefore = await usdc(admin.toSuiAddress());
await run(txs.approveTx(shop.id, shop.coinType, worker.toSuiAddress()), business, 'business approves');
assert((await usdc(worker.toSuiAddress())) === 2_000_000n, 'worker received 2.00 USDC');
assert((await usdc(admin.toSuiAddress())) - adminBefore === 100_000n, 'treasury received the 0.10 USDC fee');
const after = await chain.listClaims(client, await chain.getTask(client, shop.id));
assert(after[0].status === ClaimStatus.Approved, 'claim shows Approved');

// --- Business closes the unused price task and gets refunded ---
const before = await usdc(business.toSuiAddress());
await run(txs.closeTx(prices.id, prices.coinType), business, 'business closes price task');
const refund = (await usdc(business.toSuiAddress())) - before;
assert(refund === 3n * (800_000n + 40_000n), `unused slots refunded (${refund})`);
assert((await chain.getTask(client, prices.id)).closed, 'task marked closed');

// --- Sponsorship allow-list covers business actions ---
const targets = txs.sponsoredTargets();
for (const fn of ['create', 'approve', 'reject', 'close']) assert(targets.includes(`${ids.gp_pkg}::task::${fn}`), `sponsor allows task::${fn}`);
assert(!targets.some((t) => t.includes('seal_approve')), 'seal_approve is never sponsored');

console.log('\nALL BUSINESS CHECKS PASSED');
