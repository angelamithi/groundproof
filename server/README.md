# Groundproof Server

The backend that makes Groundproof "callable by any AI agent" and catches fake proof.

| Part | What it does |
| --- | --- |
| **Indexer** | Follows the `task` module's events on Sui and keeps a SQLite copy of tasks and claims. |
| **Fraud checks** | On every submission: decrypts the proof (the operator is a registered verifier), checks it against the on-chain fingerprint, and scores it 0–100. |
| **REST API** | `/v1/...` for businesses and agents, authenticated by API key. |
| **MCP server** | `/mcp` (Streamable HTTP). Any MCP-capable agent can post tasks and read results. |
| **Agent wallets** | Each API key gets its own Sui wallet, funded with USDC by the customer, with per-task and daily spending limits. Keys are encrypted at rest. |
| **Webhooks** | Signed callbacks when a submission is ready (with its fraud verdict), paid, rejected, disputed, or the task closes. |
| **Jobs** | Frees slots from workers who never submitted, finalizes rejections after the dispute window, retries failed checks, delivers webhooks. |

## Fraud checks

Each submission gets a risk score (0–100) and a verdict: **ok** (<25), **review** (25–59) or
**suspicious** (60+). Reasons are shown in plain English on the business dashboard and returned by
the API.

| Check | Weight |
| --- | --- |
| Answers or photos changed after submission (on-chain fingerprint mismatch) | 100 |
| Photo identical to one submitted elsewhere (reused photo) | 80 |
| Photo taken more than 1.5 km from the task area | 60 |
| Photo timestamped before the claim, or after submission | 50 |
| Impossible travel since the worker's previous job (>150 km/h) | 50 |
| No photos in a photo task | 40 |
| On-chain capture area differs from the photo location | 30 |
| Photos more than 0.5 km apart | 20 |
| Photo 0.7–1.5 km from the area centre | 15 |
| Submitted less than a minute after claiming | 15 |
| Key answer missing | 15–40 |
| GPS accuracy worse than ±100 m | 10 |

The scores advise; they never move money on their own. The business (or agent) still approves or
rejects, and workers can dispute.

## Setup

```bash
# from the repo root
npm install
cp server/.env.example server/.env    # fill it in
cd server
npm run cli -- operator               # prints the operator address
# register it as a verifier (admin):
#   sui client call --package <PKG> --module reputation --function add_verifier \
#     --args <ADMIN_CAP> <REGISTRY> <OPERATOR_ADDRESS>
npx tsx --env-file=.env src/main.ts
```

Create an API key for a customer or agent:

```bash
npx tsx --env-file=.env src/cli.ts create-key "Acme Research" --max-reward 5 --daily 100 \
  --webhook https://acme.example/groundproof
```

Or, on a deployed server, from your laptop (set `ADMIN_TOKEN` on the server first):

```bash
curl -X POST https://<server>/admin/keys -H "authorization: Bearer <ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"name":"Acme Research","max_reward_usdc":"5","daily_limit_usdc":"100"}'
```

`GET /admin/keys` lists keys; `POST /admin/keys/:id/webhook` with `{"url": "..."}` sets a webhook.

Either way you get the API key (shown once), the webhook secret, and the agent wallet address. The customer
sends USDC to that wallet (and some SUI for gas if Enoki sponsorship isn't configured).

## Deploying on Render

The repo root has a `render.yaml` Blueprint: in Render choose **New → Blueprint**, pick the
repo, and fill in the values it asks for (package/object ids, operator key, Enoki key, public URL).
It sets up a Starter web service with a 1 GB disk at `/data`. For a quick test you can switch it to
the free plan, but the free plan has no disk, so the database (including agent wallets) is wiped
on every restart. Full walkthrough: the Testnet Deployment Guide.

## Using it from an AI agent (MCP)

Point any MCP client at `https://<your-server>/mcp` with header `Authorization: Bearer <api key>`.

Tools: `post_task`, `get_task_status`, `get_result`, `approve_submission`, `reject_submission`,
`close_task`, `list_tasks`, `get_account`.

For example, an agent asked *"Is Goodlife Pharmacy on Westlands Road really open?"* calls
`post_task` with `kind: business_check`, a location and instructions, waits for the
`submission.ready` webhook or polls `get_task_status`, reads `get_result`, and approves
submissions whose fraud check is `ok`.

## REST API

All endpoints take `Authorization: Bearer <api key>`.

| Method | Path | |
| --- | --- | --- |
| GET | `/v1/account` | Wallet address, USDC balance, limits, today's spend |
| POST | `/v1/tasks` | `{ kind, location, instructions, reward_usdc, workers?, hours? }` |
| GET | `/v1/tasks` | Your tasks |
| GET | `/v1/tasks/:id` | Status, submissions, fraud checks |
| GET | `/v1/tasks/:id/results` | Decrypted answers, photo metadata and URLs |
| GET | `/v1/tasks/:id/submissions/:worker/photos/:i` | The JPEG |
| POST | `/v1/tasks/:id/approve` | `{ worker }` pays the worker |
| POST | `/v1/tasks/:id/reject` | `{ worker, fraud? }` |
| POST | `/v1/tasks/:id/close` | Refund unused escrow |
| GET | `/v1/checks/:taskId` | Fraud scores only (no auth; used by the dashboard) |

Errors: `400` bad input, `401` bad key, `402` not enough USDC, `403` over a spending limit,
`404` not your task.

## Webhooks

`POST` to the key's webhook URL with JSON `{ event, created_at, data }` and headers:

- `X-Groundproof-Event`: `submission.ready`, `submission.paid`, `submission.rejected`,
  `dispute.opened`, `dispute.resolved` or `task.closed`
- `X-Groundproof-Timestamp`: Unix seconds
- `X-Groundproof-Signature`: `sha256=` + HMAC-SHA256(webhook secret, `"{timestamp}.{body}"`)

Verify the signature and reject timestamps older than 5 minutes. Failed deliveries are retried
with backoff (8 attempts).

## Tests

```bash
npm run typecheck
NEXT_PUBLIC_PACKAGE_ID=0x1 node --import tsx --test test/fraud.test.ts   # 8 scoring rules
npx tsx test/e2e-localnet.ts <ids.json> <admin key file>                 # 32 end-to-end checks
```

The end-to-end test runs the real server against a local Sui network. An AI agent connects over
MCP, posts a 3-worker task and hits its spending limits. An honest worker passes the fraud check;
a cheater who reuses the honest worker's photo from across town is flagged (risk 100). Then the
agent reads the decrypted results and photos over REST, approves and pays, and rejects as fraud.
The jobs finalize the rejection (strike recorded) and expire the no-show. The task is closed and
refunded, and all five webhook types arrive with valid signatures.

## Before production

- **Custody:** agent wallets are held by the server. Start with low limits, keep `MASTER_KEY` in
  a secrets manager, and get legal advice on holding customer funds (consider moving to
  customer-controlled wallets or per-task approvals later).
- Move from SQLite to Postgres when you run more than one server instance.
- Put the API behind HTTPS and rate limits; add API-key self-service to the business dashboard.
- Add more checks over time: image similarity (not just identical files), EXIF/device
  signals, and cross-checking answers between workers on multi-worker tasks.
