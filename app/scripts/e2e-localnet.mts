// End-to-end check of the worker app's chain code against a local Sui network.
// Usage: sui start --with-faucet --force-regenesis, publish the Move package, then
//   npx tsx scripts/e2e-localnet.mts <PACKAGE_ID> <CONFIG_ID> <REGISTRY_ID>
process.env.NEXT_PUBLIC_PACKAGE_ID = process.argv[2];
process.env.NEXT_PUBLIC_CONFIG_ID = process.argv[3];
process.env.NEXT_PUBLIC_REGISTRY_ID = process.argv[4];
process.env.NEXT_PUBLIC_COIN_TYPE = '0x2::sui::SUI';
const W = '../lib';
const { SuiGrpcClient } = await import('@mysten/sui/grpc');
const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
const { Transaction } = await import('@mysten/sui/transactions');
const { requestSuiFromFaucetV2 } = await import('@mysten/sui/faucet');
const chain = await import(`${W}/chain.ts`);
const txs = await import(`${W}/tx.ts`);
const geo = await import(`${W}/geohash.ts`);
const { ClaimStatus } = await import(`${W}/types.ts`);
const PKG = process.argv[2], CONFIG = process.argv[3];

const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000' });
const requester = new Ed25519Keypair(), worker = new Ed25519Keypair();
for (const kp of [requester, worker])
  await requestSuiFromFaucetV2({ host: 'http://127.0.0.1:9123', recipient: kp.toSuiAddress() });
await new Promise((r) => setTimeout(r, 3000));

async function run(tx, signer, label) {
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  const ok = res.Transaction?.effects?.status?.success ?? res.$kind;
  await client.core.waitForTransaction({ digest: (res.Transaction ?? res.FailedTransaction).digest });
  console.log(`✓ ${label}`, res.$kind);
  if (res.$kind !== 'Transaction') throw new Error(`${label} failed: ${JSON.stringify(res.FailedTransaction?.effects?.status)}`);
}

// Requester creates a 2-slot business check in Nairobi (Westlands)
const cell = geo.encode(-1.2676, 36.8108, 6);
const reward = 1_000_000n, fee = 50_000n, slots = 2n;
const create = new Transaction();
const [pay] = create.splitCoins(create.gas, [slots * (reward + fee)]);
create.moveCall({
  target: `${PKG}::task::create`, typeArguments: ['0x2::sui::SUI'],
  arguments: [create.object(CONFIG), pay, create.pure.u8(0), create.pure.string(cell),
    create.pure.string('Confirm the pharmacy sign and opening hours.'), create.pure.u64(reward),
    create.pure.u64(slots), create.pure.u64(Date.now() + 86_400_000), create.object('0x6')],
});
await run(create, requester, 'create task');

const cfg = await chain.getPlatformConfig(client);
console.log('config', cfg);
const open = await chain.listOpenTasks(client);
console.log('open tasks', open.map((t) => ({ id: t.id, kind: t.kind, cell: t.locationCell, reward: t.reward, open: t.openSlots, coin: t.coinType })));
const task = open[0];
if (!task || task.locationCell !== cell || task.reward !== reward || task.openSlots !== 2) throw new Error('task parse mismatch');

console.log('stats before register', await chain.getWorkerStats(client, worker.toSuiAddress()));
await run(txs.registerTx(), worker, 'register');
console.log('stats after register', await chain.getWorkerStats(client, worker.toSuiAddress()));
await run(txs.claimTx(task.id, task.coinType), worker, 'claim');
let claim = await chain.getMyClaim(client, task, worker.toSuiAddress());
console.log('claim', claim);
if (claim?.status !== ClaimStatus.Claimed) throw new Error('claim status');

await run(txs.submitProofTx({ taskId: task.id, coinType: task.coinType, proofBlobId: 'walrus-blob-xyz',
  answerHash: new Uint8Array(32).fill(7), capturedCell: cell }), worker, 'submit proof');
claim = await chain.getMyClaim(client, await chain.getTask(client, task.id), worker.toSuiAddress());
console.log('claim after submit', claim);
if (claim?.status !== ClaimStatus.Submitted || claim.proofBlobId !== 'walrus-blob-xyz') throw new Error('submit status');

const reject = new Transaction();
reject.moveCall({ target: `${PKG}::task::reject`, typeArguments: [task.coinType],
  arguments: [reject.object(task.id), reject.pure.address(worker.toSuiAddress()), reject.pure.bool(true), reject.object('0x6')] });
await run(reject, requester, 'requester rejects (fraud flag)');
await run(txs.disputeTx(task.id, task.coinType), worker, 'worker disputes');
claim = await chain.getMyClaim(client, task, worker.toSuiAddress());
console.log('claim after dispute', claim);
if (claim?.status !== ClaimStatus.Disputed || !claim.fraudFlag) throw new Error('dispute status');

const t2 = await chain.getTask(client, task.id);
console.log('task now', { approved: t2.approved, active: t2.active, open: t2.openSlots });
console.log('targets', txs.sponsoredTargets().length);
console.log('\nALL CHECKS PASSED');
