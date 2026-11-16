# Groundproof App

One Next.js app with two sides:

- **Worker app** (`/`): mobile-first, installable PWA where workers in Africa find nearby tasks,
  capture GPS-stamped proof, and get paid in stablecoins.
- **Business dashboard** (`/business`): where companies and AI-agent builders post and fund
  tasks, review proof, and approve or reject.

Built with Next.js, Sui dApp Kit and Enoki.

## What a worker can do

1. **Sign in with Google** (zkLogin via Enoki). No wallet app, no seed phrase.
2. **Join** (registers on-chain in the reputation registry).
3. **See open tasks**, sorted by distance from their current location.
4. **Take a task** (claims a slot in the escrowed task).
5. **Capture proof** with the in-app camera only (no gallery uploads). Each photo is stamped
   with GPS and time, plus a short form per task type (business check, price photo, language).
6. **Submit**: the app checks they're within 1.5 km of the task, builds a proof bundle,
   encrypts it with **Seal** (only the customer can open it), stores it on **Walrus**, and
   records the blob id and a SHA-256 commitment on-chain.
7. **Follow up**: collect payment if the customer goes silent (auto-release), **dispute** or
   accept a rejection.
8. **Earnings**: balance, completed tasks, level and strikes.

All worker transactions are **gas-free**: the app's server asks Enoki to sponsor them, and only
Groundproof's own Move functions can be sponsored.

The interface is in **English and Swahili** (toggle in the header).

## Business dashboard

1. **Sign in with Google** (same zkLogin flow; no crypto wallet needed).
2. **Dashboard**: USDC balance, live tasks, work in progress, completed checks, rewards in escrow.
3. **New task**: type, location (coordinates or a pasted Google Maps link), instructions, reward,
   number of workers, deadline. Shows rewards + 5% fee before funding; the total is locked in escrow.
4. **Bulk upload**: CSV with `kind, location, reward_usdc, workers, hours, instructions`
   (template downloadable). Rows are validated first, then created 20 per transaction.
5. **Review**: each submission shows its status and where it was captured. **Open proof**
   decrypts it with Seal (one wallet signature per session), shows photos with time, GPS accuracy,
   distance and a map link, plus the worker's answers, and checks the proof against the
   on-chain fingerprint (any edited answer or swapped photo is flagged).
6. **Approve and pay**, **Reject (not usable)** or **Reject as fraud**; change your mind during a
   dispute; **Close and refund** unused slots; **Export CSV** of results.

Business actions are sponsored too, so a business only needs USDC, not SUI.

## Setup

```bash
npm install                    # run at the repo root (npm workspaces)
cp .env.example .env.local     # then fill it in (see below)
npm run dev                    # http://localhost:3000
```

Fill in `.env.local`:

| Variable | Where it comes from |
| --- | --- |
| `NEXT_PUBLIC_PACKAGE_ID`, `NEXT_PUBLIC_CONFIG_ID`, `NEXT_PUBLIC_REGISTRY_ID` | Output of `sui client publish` for the `groundproof` Move package |
| `NEXT_PUBLIC_COIN_TYPE` | The stablecoin type tasks pay in (e.g. testnet USDC) |
| `NEXT_PUBLIC_ENOKI_PUBLIC_KEY`, `ENOKI_PRIVATE_KEY` | [Enoki portal](https://portal.enoki.mystenlabs.com): create an app, enable zkLogin and sponsored transactions |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth client (Web). Add `http://localhost:3000/auth` and your production `/auth` URL as redirect URIs, and add the client id in Enoki |
| `NEXT_PUBLIC_SEAL_KEY_SERVERS` | Seal key server object ids for your network (Seal docs) |
| `NEXT_PUBLIC_WALRUS_PUBLISHER` | Defaults to the public testnet publisher |

In the Enoki portal, also allow-list the package's Move call targets for sponsorship.

Camera and GPS need **HTTPS** on phones. For phone testing, deploy to Vercel (free) or use a
tunnel such as `cloudflared` instead of `localhost`.

## Local development without keys

You can run everything on a local Sui network with a built-in test wallet (no Google, Enoki,
Seal or Walrus needed):

1. `sui start --with-faucet --force-regenesis`, then publish the `groundproof` package and a test
   coin (see `scripts/e2e-business-localnet.mts` for the ids it expects).
2. Start the storage stand-in: `python3 scripts/walrus-mock.py` (port 9300).
3. In `.env.local` set `NEXT_PUBLIC_SUI_NETWORK=localnet`, `NEXT_PUBLIC_DEV_WALLET=true`,
   `NEXT_PUBLIC_ALLOW_UNENCRYPTED=true`, `NEXT_PUBLIC_WALRUS_PUBLISHER` and
   `NEXT_PUBLIC_WALRUS_AGGREGATOR` to `http://127.0.0.1:9300`, plus the package/object ids.
4. `npm run build && npm start`, then choose **Use local test wallet** and fund the address
   from the local faucet.

Never enable `NEXT_PUBLIC_DEV_WALLET` or `NEXT_PUBLIC_ALLOW_UNENCRYPTED` in production.

## Project layout

```
app/
  business/page.tsx          business dashboard (KPIs + task table)
  business/new/page.tsx      create task (form + bulk CSV)
  business/task/[id]/page.tsx  review: open proof, verify, approve/reject, close, export
  page.tsx            worker: sign in → join → nearby tasks
  task/[id]/page.tsx  task details, claim, camera + form, submit, dispute / collect
  wallet/page.tsx     earnings and reputation
  auth/page.tsx       Google sign-in callback
  api/sponsor         server: Enoki gas sponsorship (allow-listed Move calls only)
  api/execute         server: submit the signed sponsored transaction
components/           Header, SignIn, Camera, formatting helpers
lib/
  config.ts           environment settings
  dappkit.ts          dApp Kit + Enoki Google wallet
  chain.ts            read tasks, claims, reputation, balances (BCS-decoded)
  tx.ts               transaction builders for every worker action
  sponsor.ts          sponsored transaction flow
  proof.ts            proof bundle, SHA-256 commitment, Seal encryption, Walrus upload
  geohash.ts          location cells and distances
  types.ts            BCS layouts mirroring the Move structs
  i18n.tsx            English / Swahili strings
  business.ts         location parsing, USDC amounts, CSV import/export
scripts/
  e2e-localnet.mts           worker flow against a local Sui network
  e2e-business-localnet.mts  business flow against a local Sui network (30 checks)
  walrus-mock.py             local stand-in for Walrus storage
```

## Tested

- `npm run build` passes (TypeScript strict).
- `scripts/e2e-localnet.mts`: worker flow on a local Sui network (create → list → register →
  claim → submit → reject → dispute), every on-chain read decoded by the app's own code.
- `scripts/e2e-business-localnet.mts`: business flow with a test USDC coin: CSV import, cost and
  fee maths, 3 tasks funded in one transaction, dashboard listing, proof verification (edited
  answers and swapped photos are caught), approve (worker paid 2.00, treasury 0.10), close and
  refund.
- Full browser run in headless Chrome (desktop business + phone worker with fake camera and GPS):
  post task → worker joins, claims, takes 2 photos, submits → business opens proof, sees
  "Matches the on-chain record", approves → worker sees 2.00 USDC, in English and Swahili.
- Not yet tested with real Google sign-in, Enoki sponsorship, Seal and Walrus (needs your keys).

## Before mainnet

- Rate-limit `/api/sponsor` per address and check the caller's Enoki session.
- Have the backend re-check GPS, timestamps and duplicate photos (client checks can be bypassed).
- Blur faces in photos before encryption.
- Offline queue for slow connections (capture now, upload when back online).
