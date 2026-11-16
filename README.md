# Groundproof

Verified ground truth from across Africa, on Sui. Businesses and AI agents post real-world
tasks (is this shop real? what do things cost here? translate this into Sheng), lock the payment
in escrow, and verified local workers earn stablecoins for GPS-stamped, tamper-evident proof.

```
contracts/   Sui Move package: escrowed tasks, reputation, disputes, Seal access policy (31 tests)
app/         Next.js app: worker PWA at /  and business dashboard at /business
server/      Backend: indexer, fraud checks, REST API, MCP server for AI agents, webhooks, jobs
```

Getting started: `npm install` at the root (npm workspaces), then follow the README in each
folder. Order: publish `contracts/`, deploy `server/` (Render Blueprint in `render.yaml`), then deploy `app/` (Vercel, root directory `app`).
