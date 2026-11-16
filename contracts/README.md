# Groundproof — ground truth for Africa (Sui Move contracts)

**Groundproof** gives AI agents and businesses verified proof from the ground. They post real-world tasks in Africa
(check a business exists, photograph a price list, translate Swahili), lock the payment in
escrow, and verified local workers get paid in stablecoins when their proof is approved.

This package is the on-chain core of the MVP: money, task state, proofs and reputation.

## Modules

| Module | What it does |
| --- | --- |
| `config` | Shared `Config` (platform fee, treasury, pause switch, claim and auto-release windows) and the `AdminCap`. Fee defaults to 5% and is capped at 20%. |
| `reputation` | Shared `Registry` of workers (completed, rejected, strikes, banned) and of trusted verifiers. Three fraud strikes = automatic ban. `level()` gives 0–3. |
| `task` | `Task<T>` with escrowed coin `T` (e.g. USDC). Create, claim, submit proof, approve, reject, dispute, verifier vote, auto-release, expire stale claims, close with refund, and the Seal `seal_approve` access policy (the requester and trusted verifiers can decrypt proofs). |

## Task lifecycle

1. **Requester** calls `task::create` with exactly `slots × (reward + fee)` of coin `T`.
2. **Worker** (registered via `reputation::register`) calls `task::claim`. One claim per worker per task.
3. Worker uploads Seal-encrypted photos to Walrus, then calls `task::submit_proof` with the
   blob id, a sha256 of their answers, and a coarse location cell, within the claim window (default 2 h).
4. Requester calls `approve` (worker gets `reward`, treasury gets `fee`) or `reject`
   (optionally flagged as fraud). A rejection is **held for the dispute window** (default 24 h):
   - the worker accepts it (`finalize_rejection`), or lets the window pass and anyone finalizes it;
   - or the worker calls `dispute`, and trusted verifiers `vote`. The first side to reach the
     quorum (default 1, raise to 3 later) wins: worker paid, or rejection made final.
   - The requester can still `approve` during the window or a dispute.
   - Strikes only count when a rejection is final, so unfair rejections can't get workers banned.
5. If the requester is silent for the auto-release window (default 48 h), the worker calls `auto_release`.
6. Anyone can call `expire_claim` on a claim never submitted in time; the slot reopens.
7. Requester can `close` at any time: unclaimed money is refunded immediately, reserved money
   is refunded as remaining claims are rejected or expire.

## Build and test

```bash
# install the Sui CLI: https://docs.sui.io/guides/developer/getting-started/sui-install
sui move build
sui move test        # 31 tests (add --build-env testnet if your active env is local)
```

## Deploy to testnet

```bash
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443   # if not set up
sui client switch --env testnet
sui client faucet                       # free testnet SUI for gas
sui client publish --gas-budget 200000000
```

Save from the output: the **package id**, the shared **Config** and **Registry** object ids,
and the **AdminCap** id. The frontend and backend need all four. Then add at least one
verifier: `reputation::add_verifier(AdminCap, Registry, <address>)`.

## Known gaps (next iterations)

- **Requester reputation:** track how often each requester's rejections are overturned.
- **Verifier pay:** a small fee per dispute vote, funded from the platform fee.
- **Level-gated tasks:** add a `min_level` to tasks so high-value jobs only go to trusted workers.
- **Consensus tasks:** pay only when 2–3 workers' answer hashes agree.
- **Agent spending limits:** per-agent budgets for AI agents posting tasks.
- **Audit:** get a security review before holding real money on mainnet.

## Next steps in the build plan

- Worker app (Next.js PWA): zkLogin, task map, in-app camera with GPS, Walrus upload, Seal encryption.
- Requester dashboard: create and fund tasks, review proofs, CSV import/export.
- Backend: event indexer, sponsored transactions, AI/GPS checks, REST API and MCP server for AI agents.
