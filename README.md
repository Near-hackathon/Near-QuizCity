# QUIZ CITY

A browser multiplayer city where quiz credits (QC) are integer game credits recorded on-chain. Players prove knowledge, take jobs, buy plots, open venues, and trade businesses. Every balance and ownership claim is enforced by a NEAR smart contract; PostgreSQL stores gameplay progress alongside a rebuildable chain mirror.

Built for the NEAR "Games With Real Economies" hackathon.

The browser opens on an illustrated landing page. Click **Play**, enter a username and
first name, and meet the welcome guide. Returning residents enter with one click on the
same browser. Profiles use an HttpOnly device credential; usernames are not passwords.
Connect a NEAR wallet inside the phone to use the economy and enable wallet recovery.

The city runs full-screen with a small floating phone. Jobs, quizzes, wallet setup,
property purchases, shops, stock controls and owner withdrawals stay inside that phone.
Six residents have generic display names and daily routines. The apartment belongs to
Professor Reed; other residents work, take breaks and walk around the city.
See the delivery notes below for scope.

Research offers now include a saved reading brief, knowledge check and summary. Shops
use server-priced stock reservations and the idempotent `pay_order` contract method.
**Testnet contract updated on 14 November 2026.** The production artifact is deployed
with a state-preserving migration, and the server uses a restricted payout key.
Automatic accounts now complete registration and receive their confirmed starter
allowance. The retired full-access server key was revoked after explicit owner approval;
QC-0105 is complete.

For the city, prepare licensed local assets with `npm run assets:prepare`, check maps
with `npm run maps:check`, apply pending database migrations while the API is stopped,
then run `npm run dev`. Exterior collision migration `0023` preserves sessions and
relocates only players inside the newly blocked facades. Browser smoke, local-stack
tests, asset preparation and release checks are covered by the repository test scripts.

The district visual pass uses `new assets/building free.png`,
`new assets/free campus assets.png`, and
`new assets/InteriorsAndFurniture/FurnitureSheet.png`. Keep these local files at those
paths and rerun `npm run assets:prepare` after adding them. The catalogue records the
owner's permission confirmation separately from creator-supplied licences. Raw packs
and generated copies remain ignored. Migration `0026` activates the furniture collision
layouts and safely relocates newly blocked positions; stop the API while applying it.
The visual pass was verified locally.

- Contract (testnet): [`quizcity.testnet`](https://testnet.nearblocks.io/address/quizcity.testnet)
- Web app: Vite + React (runs at http://localhost:5173)
- API: Fastify at http://localhost:8787

## The loop

1. **Register** — creates your on-chain identity and logical wallet `player:<account>`.
2. **Claim 500 QC** — one-time starter allowance, once per account.
3. **Work** — take a job from Professor Reed (an NPC with a bounded wallet), finish it, get paid by the NPC, not by minting.
4. **Learn** — pass the daily quiz (6 of 8). Rewards are operator-signed and capped at 1,000 QC per call.
5. **Own** — buy a plot. The contract moves QC and title atomically; a plot cannot have two owners.
6. **Trade** — open a venue (100 QC permit, burned), list stocked items, and transfer the business to another player.

Running totals (`total_issued`, `total_burned`, `tx_count`) are on chain, so the economy is auditable rather than asserted. `tx_count` counts ledger movements (mint, burn, transfer); registry events have their own monotonic `seq` in the canonical event log.

## Architecture

```
React (near-api-js, client-side signing)
  │  signed transactions
  ▼
NEAR testnet ── quizcity.testnet (Rust 1.95, near-sdk 5.30.1)
  │  views + tx outcomes + EVENT_JSON logs
  ▼
Fastify API ── verifies tx (hash, signer, status, events)
  │
  ▼
Postgres (read model: players, wallets, jobs, quizzes, ledger, NPC state)
```

The server never trusts a client claim. Each write endpoint takes a `txHash`, fetches the final outcome, checks the signer and `SuccessValue`, reads the resulting chain state/events, and only then mirrors it. A forged or replayed hash cannot create a balance.

### Why NPCs cannot print money

`pay_job` is operator-only and moves QC from the NPC wallet to the worker via the same internal transfer used by players. Professor Reed starts with 1,000 QC and pays 100 per job, so he stops hiring when his wallet runs dry. Quiz rewards are the only minted issuance, and they are per-call capped. Both `pay_job` and `credit_reward` require a unique reference, so a retried HTTP request cannot pay twice.

## Repo layout

```
contract/        Rust contract, unit tests, deployable wasm
server/          Fastify API, Postgres schema, sync + operator, scripts
web/             React shell, Phaser city, landing page and in-game phone
packages/        Shared protocol schemas, maps and navigation data
```

Implementation planning, audit history and phase reviews are maintained outside the published repository.

## Quick start

Prerequisites: Node 20.20 (see `.nvmrc`), Rust 1.95 (`contract/rust-toolchain.toml`), `cargo-near` 0.23, Postgres 17.

The contract uses `near-sdk` 5.30.1, which declares protocol version 85, so rustc 1.95 builds the WASM and runs the tests. Contract commands must run from `contract/`; `cargo near build --manifest-path` from the repository root uses the root toolchain instead of the pin. The root scripts below run every contract command through `scripts/run-contract.mjs`, and `npm run toolchain:check` verifies the active compiler matches the pin.

```bash
npm ci

# 1. Database and configuration
cp server/.env.example server/.env        # first setup only; preserve an existing .env
# Set DATABASE_URL and the configured contract/operator values in server/.env.
# Local demo only: APP_ENV=local, HOST=127.0.0.1, NEAR_NETWORK=testnet, DEMO_MODE=1
createdb quizcity
npm run db:push                       # applies ordered SQL migrations from server/db/migrations/
npm run db:seed                       # demo quiz, job, NPC, and connected world seed (idempotent)
npm run world:seed:residents          # six scheduled residents (idempotent)
npm run assets:prepare               # requires the local art packs described above
# npm run db:reset requires --confirm-local-reset and APP_ENV=local|test
# npm run db:test runs PostgreSQL integration tests against TEST_DATABASE_URL

# 2. Contract checks (only needed if you change the contract)
npm run contract:test                     # production contract unit tests
npm run contract:fmt:check
npm run contract:clippy                   # includes the demo-reset feature
npm run contract:build                    # production WASM, no demo helpers

# 3. Run against the configured contract; no deployment or reset is needed.
npm run dev                               # API :8787, web :5173
```

Open `http://localhost:5173`, click **Play**, and create a resident. To run only the
API, use `npm run dev --workspace=server` from the repository root. Run the web app
separately with `npm run dev --workspace=web`. Stop an existing API before starting
another on port 8787.

Live contract deployment is a separate administrator operation. Complete
QC-0105's recovery-key and restricted-payout-key sequence before using `chain:seed`;
that command deploys and resets disposable testnet state. It is not part of normal
local startup. Local contract/RPC tests use `npm run test:e2e:local` instead.

`.env` keys: `APP_ENV`, `DEMO_MODE`, `DATABASE_URL`, `PGSSL`, `PORT`, `HOST`, `WEB_ORIGIN`, `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_CONTRACT_ID`, `NEAR_OPERATOR_ACCOUNT`, `NEAR_OPERATOR_PRIVATE_KEY`, `NPC_TICK_MS`, `E2E_API`, and the chain/readiness worker settings (`CHAIN_EVENT_SOURCE_URL`, `CHAIN_SOURCE_REQUIRED`, `CHAIN_START_BLOCK`, `CHAIN_POLL_INTERVAL_MS`, `CHAIN_PAGE_SIZE`, `CHAIN_FETCH_TIMEOUT_MS`, `CHAIN_MAX_RETRIES`, `READINESS_TIMEOUT_MS`). Staging and production refuse to start without a chain event source unless `CHAIN_SOURCE_REQUIRED=0` is set explicitly. Configuration is validated once at startup; invalid or missing values stop the process with an actionable message and a redacted summary is logged. Tests import the pure validator and need no `.env`.

`NEAR_OPERATOR_PRIVATE_KEY` is a payout-only function-call key for exactly `credit_reward,pay_job,settle_escrow,npc_purchase`. `NEAR_DEPLOY_PRIVATE_KEY` is the contract account's offline full-access deploy/recovery key and is required only for `npm run chain:seed`; pass it in the shell and never store it in `server/.env`.

Use `https://rpc.testnet.fastnear.com`; the public `rpc.testnet.near.org` endpoint is rate-limited and returns 429s.

## Demo walkthrough

1. Open **Play** and create a browser resident, or return through a saved username.
   Link a wallet through the phone. Disposable Alice/Bob adapters are available only
   in explicitly enabled local demo mode.
2. Register → claim 500 → accept and complete Professor Reed's job (+100).
3. Play the daily quiz (+25 on a pass, once per day).
4. Buy plot `#1` for 300 QC.
5. Open a venue on the plot (−100 permit), add catalogue stock, and purchase an item
   as another player. Checkout requires the reviewed updated contract deployment.
6. Transfer the venue to Bob from Alice's business panel.
7. After the job is paid, the NPC tick posts a fresh job within ~20s — the city keeps hiring as long as the professor has QC.

## Contract API

| Method                                                                    | Who                         | Effect                                                 |
| ------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `register_player(username)`                                               | anyone                      | Creates `player:<account>` with 0 QC                   |
| `claim_starter()`                                                         | player                      | One-time 500 QC, tracked on chain                      |
| `transfer_qc(to_wallet, amount)`                                          | wallet owner                | Internal transfer, positive amount only                |
| `credit_reward(wallet, amount, reference)`                                | operator                    | Mints capped at 1,000 per call; idempotent             |
| `pay_job(employer, employee, amount, reference)`                          | operator                    | Moves NPC/business QC; idempotent                      |
| `create_wallet(wallet, initial_balance)`                                  | operator                    | Creates `player:`, `npc:`, `gov:`, `biz:` wallets      |
| `create_property(kind, district, x, y, owner_wallet, price)`              | operator/seeder             | Creates a titled plot; coordinates unique              |
| `list_property(id, price)` / `cancel_property_listing(id)`                | owner/operator              | Lists or cancels a sale                                |
| `buy_property(id)`                                                        | any player                  | Atomic QC + title swap; no self-buy                    |
| `create_business(property_id, name)`                                      | plot owner                  | 100 QC permit, burned; one per property                |
| `pay_service(business_id, amount)`                                        | customer                    | Pays the business treasury                             |
| `pay_order(business_id, amount, reference)`                               | customer                    | Idempotent payment bound to buyer, business and total  |
| `supports_orders()`                                                       | anyone                      | Checkout capability view                               |
| `business_withdraw(id, amount)`                                           | owner                       | Owner-only treasury withdrawal                         |
| `transfer_business(id, new_owner)`                                        | owner                       | Moves the operating company only                       |
| `set_paused(paused)` / `propose_operator` / `accept_operator`             | operator                    | Pause payouts; two-step operator rotation              |
| `is_reference_processed(reference)`                                       | anyone                      | Payout reconciliation view                             |
| `reset_demo` / `migrate_reset`                                            | operator / contract account | Demo-reset build only; `migrate_reset` is `#[private]` |
| `get_balance / get_player / get_property / get_business / get_stats`      | anyone                      | Single-entity views                                    |
| `get_properties(from_index, limit)` / `get_businesses(from_index, limit)` | anyone                      | Pages of up to 100 items                               |

State-changing methods emit canonical NEP-297-style `EVENT_JSON` logs. Each ledger movement has one event with `seq`, `wallet_from`, `wallet_to`, `amount`, `reference`, and `entity_id`. The server reads those events for amounts and parties instead of trusting the request body.

## Server API

`GET /health/live` · `GET /health/ready` · `GET /v1/config` · `GET /v1/demo/accounts` · `GET /v1/players/:account` · `GET /v1/jobs` · `GET /v1/npcs` · `GET /v1/quizzes` · `GET /v1/transactions` · `GET /v1/snapshots` · `GET /v1/contract/stats` · `GET /v1/auth/me`

`POST /v1/auth/nonce` · `POST /v1/auth/verify` · `POST /v1/auth/logout` · `POST /v1/players/register` · `POST /v1/players/claim` · `POST /v1/jobs/:id/accept` · `POST /v1/jobs/:id/submit` · `POST /v1/jobs/:id/verify` · `POST /v1/jobs/:id/complete` · `POST /v1/jobs/:id/retry-payment` · `POST /v1/quizzes/:id/start` · `POST /v1/quizzes/:id/submit` · `POST /v1/properties/:id/buy` · `POST /v1/businesses` · `POST /v1/businesses/:id/pay` · `POST /v1/businesses/:id/transfer` · `POST /v1/sync`

All mutating routes require an authenticated session plus the `x-csrf-token` header. Identity comes from the session cookie; request bodies never supply `accountId`.

Sign-in implements NEP-413. `POST /v1/auth/nonce` returns the application message, a 32-byte nonce (base64 transport), the contract recipient, and the configured callback URL. The client decodes the nonce to 32 bytes and calls the wallet's standard `signMessage({ message, recipient, nonce, callbackUrl })`; the wallet signs `SHA256(Borsh(u32(2147484061)) || Borsh({message,nonce,recipient,callbackUrl}))`. `POST /v1/auth/verify` validates the nonce encoding, re-derives the same digest from stored issued/expiry times, requires the submitted key to have `FullAccess` permission (function-call keys cannot log in), verifies the signature, and only then consumes the nonce and creates the session. Raw-JSON signatures do not verify. The local demo signer computes the same digest, so demo and production share one protocol.

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever `APP_ENV` is staging/production or `WEB_ORIGIN` is HTTPS — proxy TLS termination is therefore safe. `/jobs/:id/retry-payment` is operator/admin only.

QC amounts are canonical decimal strings, never JavaScript numbers. Validation failures and application errors use one envelope: `{"error":{"code","message","requestId","details"}}`. Fastify validation runs from TypeBox schemas (including a `qc-amount` format that rejects U128 max + 1 before the handler), and OpenAPI is served at `/documentation` only when `APP_ENV=local` or `ENABLE_API_DOCS=1`. Lists return `{items, nextCursor}`; `/health/live` and `/health/ready` are the only stable non-versioned routes. `/health/ready` checks PostgreSQL, a contract view, and the configured indexer independently, each with a timeout, and returns safe `checks` statuses plus 503 when a required dependency fails. `/health/live` performs no dependency I/O. Job verification and `/sync` require an `operator` or `admin` role; grant local/test roles with `npm run role:grant -- --account <id> --role <role> --confirm-grant-role`.

## Tests

```bash
npm run verify                             # static checks, contract/server tests, builds, ABI
npm run db:test                            # PostgreSQL integration tests (TEST_DATABASE_URL, temporary schemas)
npm run test:web                           # web unit/component/accessibility tests
npm run test:e2e:local                     # local NEAR sandbox economic loop and attacks
npm run verify:all                         # verify + database + web + local E2E
npm run smoke:testnet                      # guarded manual testnet check (RUN_TESTNET_SMOKE=1)
npm run exploit:testnet                    # guarded legacy manual exploit script
```

`npm run verify` runs the production contract tests (53), demo-reset contract tests (56), 137 server tests, the toolchain, WASM-export, and coverage-reporter tests, formatting/linting/typechecks, both builds, and a production-WASM check that reads real function exports and rejects demo helpers. `npm run test:coverage --workspace=server` enforces reviewed floors of 68% lines, 88% branches, and 78% functions. `npm run db:test` executes 117 PostgreSQL integration tests for migrations, ledger atomicity/conflict behavior, NEP-413 auth, transaction consumption, quiz snapshots, job payment races/reconciliation, chain ingestion/rebuild/dead-letter handling, readiness, sync, and the world seed against disposable schemas. Both database and local E2E commands require an explicit disposable `TEST_DATABASE_URL` and never fall back to the development database.

`smoke:testnet` and `exploit:testnet` mutate shared testnet state and are opt-in only: they require `RUN_TESTNET_SMOKE=1`, `APP_ENV=local|test`, and testnet. They are never part of `verify` or pull-request CI. Local deterministic coverage lives in `server/test/e2e/` and `web/src/**/*.test.tsx`. CI jobs and required checks are defined in `.github/workflows/verify.yml`.

`e2e` drives register → claim → job → quiz → property → business → transfer and asserts exact balances. `exploit` mutates demo state, so reset afterwards (below). It covers forged hashes, cross-account transaction use, SQL injection in paths, answer leakage, quiz replay, non-employee job completion, request-tampered payment amounts, demo-key leakage, and ledger duplication.

The deterministic local E2E end state is Alice 225 QC, Bob 485 QC, Professor Reed 9,900 QC, business treasury 15 QC, and council 300 QC. The flow includes a 5 QC owner withdrawal after the 20 QC service payment and verifies that exact receipt replay does not apply it twice.

## Reset

```bash
npm run contract:build:demo   # demo build includes migrate_reset
NEAR_DEPLOY_PRIVATE_KEY=<contract-account-full-access-key> npm run chain:seed
npm run db:reset              # destructive mirror reset (requires --confirm-local-reset, local/test only)
npm run db:seed               # quiz, job, NPC, and connected world rows
```

The root `chain:seed` script rebuilds the demo artifact, runs the demo ABI check, prints its SHA-256, and refuses to deploy a WASM that lacks `migrate_reset`/`reset_demo`. `migrate_reset` is `#[private]`: only the contract account can call it, and the migrated operator is the contract account. The demo build is disposable. `migrate_reset` writes fresh collection prefixes, so prior demo entries are orphaned rather than migrated. Production builds omit `reset_demo` and `migrate_reset`; the verify step asserts this against the WASM.

## Demo mode and key rotation

Demo sign-in is opt-in and local-demo-only. `DEMO_MODE=1` is accepted only when all of these hold:

- `APP_ENV=local` or `test`
- `NEAR_NETWORK=testnet`
- `HOST` is loopback (`127.0.0.1`, `localhost`, or `::1`)

With the flag absent or `0`, `GET /demo/accounts` returns 404, the web client does not mount the demo account picker, and browser commands need a wallet signer. The route also refuses to load keys unless the full configuration is safe (503 on an impossible unsafe override), filtering the operator account, the contract account, and any entry whose secret matches the operator key. Startup fails if the operator account or key is missing. Server-side NEP-413 verification is production-shaped; the shipped browser wallet adapter is a thin provider hook and the full wallet-selector UX is still deferred (QC-0502), so non-demo browser deployments remain read-only until that lands.

Demo player keys are disposable testnet keys stored in `localStorage`. Rotation is player-only and dry-run by default:

```bash
npm run demo-keys:rotate:dry-run   # lists demo player account IDs and current public keys, changes nothing
npm run demo-keys:rotate           # requires --confirm-demo-key-rotation under the hood
```

The confirmed run requires `APP_ENV=local|test`, testnet, and `DEMO_MODE=1`. It backs up only `demo-accounts.json` to `server/backups/<timestamp>/` (mode 0600, Git-ignored), adds the new demo player key, confirms it on-chain, persists it, and only then deletes the old key. It never reads or writes `.env` or the operator payout key, and it removes operator/contract entries from the demo file by account ID. If any step fails it stops immediately and prints the backup path, account IDs, and public keys only. Restore `demo-accounts.json` from the backup if the new secret was not persisted. Do not print or commit private keys.

Player demo-key rotation is separate from the server payout key. A restricted `NEAR_OPERATOR_PRIVATE_KEY` cannot safely add its own replacement, so rotating it requires the offline deployment/recovery key and an administrator:

```bash
npm run payout-key:verify -- --public-key ed25519:<new-key>
```

`payout-key:verify` is read-only. It accepts a public key only, queries `view_access_key`, and fails when the key is `FullAccess`, targets another receiver, allows extra methods, or has no finite allowance. It never accepts or prints a private key. The rotation flow is: create a new function-call key for `credit_reward,pay_job` with an allowance, verify it with `payout-key:verify`, add it as `NEAR_OPERATOR_PRIVATE_KEY`, run one payout, then delete the old key with the offline deploy key and confirm it is gone.

## Security notes

- The operator key lives only in the server environment. It is never sent to the browser and `/demo/accounts` filters it out. It must be a payout-only function-call key for `credit_reward` and `pay_job`, not a full-access key.
- Demo sign-in uses disposable testnet keys in `localStorage` and is only reachable through `DEMO_MODE=1`. Server-side auth is a real NEP-413 Borsh/prefix/SHA-256 signature check over one-time, domain/network-bound nonces; only full-access keys can authenticate. The browser supports MyNearWallet; browser-only profiles can explore before connecting a wallet.
- `DEMO_MODE` defaults to `0`; configuration omission cannot expose keys.
- The Postgres mirror can be wiped and rebuilt with `POST /sync` / `npm run db:reset`; it holds no authority.
- `reset_demo` is operator-gated; `migrate_reset` is `#[private]` and callable only by the contract account. Both exist only in the `demo-reset` build. Production builds do not export them.
- Operator payouts are capped per call, total supply is capped, and `credit_reward`/`pay_job` reject reused references. The operator can pause payouts without blocking reads; rotation is two-step (`propose_operator` then `accept_operator` from the new account).
- `npm run payout-key:verify` fails a server key that is `FullAccess`, targets another contract, allows extra methods, or has no allowance. Keep the contract account's full-access deploy/recovery key offline; only `chain:seed` needs it, via `NEAR_DEPLOY_PRIVATE_KEY` supplied in the shell.

## Repository checks

```bash
npm run verify
```

In order: Rust toolchain pin check; Prettier and `cargo fmt --check`; ESLint (runtime-specific globals) and `cargo clippy -D warnings`; TypeScript for server and web; 53 production contract tests, 56 demo-reset contract tests, 137 server tests, and the toolchain/WASM-export/coverage-reporter tests; then the contract WASM, server typecheck, and production web build; finally the production-WASM demo-helper check, which inspects `WebAssembly.Module.exports` rather than raw bytes. `npm ci && npm run verify` works without `server/.env`.

The same command runs in `.github/workflows/verify.yml` on Node 20.20 and Rust 1.95, with the WASM checksum recorded as an artifact.

## Workers and reconciliation

Four bounded workers run in-process when the API starts, each performing an
immediate first tick (restart catch-up), preventing overlap, using exponential
backoff with jitter capped after jitter, and exposing an async `stop()` that
waits for in-flight work before the lifecycle closes PostgreSQL:

- chain ingester (`CHAIN_POLL_INTERVAL_MS`, only when a source is configured)
- job payment reconciler (60s)
- quiz reward reconciler (60s)
- NPC tick (`NPC_TICK_MS`)

Manual entry points:

```bash
npm run jobs:reconcile
npm run quiz:reconcile
npm run chain:ingest
npm run chain:reconcile
npm run chain:failure -- --retry --receipt <id> --index <n>
npm run chain:failure -- --ignore --receipt <id> --index <n> --reason "<text>"
```

Unknown payout outcomes are typed (`confirmed | rejected | unknown`) and never
trigger a second blind chain call; only verified reconciliation can finalize
them. Job and quiz reward projections are replay-idempotent: pool accounting and
reconciliation counters change only on the first applied transition, and
conflicting amounts/hashes fail and roll back.

Mirror rebuild stages and validates complete provider history before replacing
active chain-owned rows. Event ordering is enforced across page boundaries,
every immutable duplicate field must match, a non-zero supply reconciliation
rolls back, and rebuild/full-sync share an exclusion guard.

## Deployment

The repository is a monorepo, but the web client and the API deploy independently.
Each platform watches only its own paths, so a web change does not rebuild the API
and an API change does not rebuild the web client.

| Target   | Sources                             | Host                             |
| -------- | ----------------------------------- | -------------------------------- |
| Web      | `web/`, `packages/`, `assets/maps/` | Cloudflare Workers               |
| API      | `server/`, `packages/`              | Fly.io using `server/Dockerfile` |
| Contract | `contract/`                         | NEAR release artifact            |

### Web: Cloudflare Workers or Pages

The web application must send `/v1/*` and `/health/*` through the same origin
that serves the game. Browser-profile and session cookies are intentionally
first-party; setting `VITE_API_URL` directly to Fly bypasses that boundary and
causes returning residents to appear missing.

For **Cloudflare Workers**, connect `Near-hackathon/Near-QuizCity` with these
Workers Builds settings:

- Root directory: repository root
- Build command: `npm run build --workspace=web`
- Deploy command: `npx wrangler deploy`
- Node version: `20.20.0`

The root is required because `web/vite.config.ts` reads `../assets/maps` and the
hoisted `../node_modules/phaser`. `wrangler.jsonc` serves `web/dist` as static
assets and proxies `/v1/*` and `/health/*` to Fly.

```text
VITE_NEAR_NETWORK=testnet
VITE_NEAR_RPC_URL=https://rpc.testnet.fastnear.com
VITE_CONTRACT_ID=quizcity.testnet
```

Leave `VITE_API_URL` unset. Production builds then use the current browser
origin automatically. Set `API_ORIGIN=https://near-quizcity.fly.dev` as a Worker
variable only when using an API other than the default.

For **Cloudflare Pages**, use the same root and build command, set output
directory to `web/dist`, and leave `VITE_API_URL` unset or remove its old Fly
value from the Pages dashboard. The repository's `functions/v1/` and
`functions/health/` proxies are discovered by Pages and forward requests to
`API_ORIGIN` (defaulting to `https://near-quizcity.fly.dev`). Set the Fly
`WEB_ORIGIN` secret to the exact deployed Pages or Worker origin, such as
`https://quiz-city.pages.dev`.

After moving an existing browser from a direct Fly deployment to Pages/Workers,
its old `qc_device` cookie cannot transfer domains. Clear the old local game
session and enter again; recover a previously linked resident through its wallet.
The API must allow the deployed Pages or Worker origin through `WEB_ORIGIN`.

### API: Fly.io

`fly.toml` builds from the repository root so npm workspaces resolve. NPC, world,
job and quiz reconciliation workers run in-process, so the API must stay a single
always-on machine; the config disables auto-stop and replaces the machine on deploy.

```bash
flyctl secrets set --app quiz-city-api \
  DATABASE_URL='postgresql://...-pooler...' \
  DATABASE_URL_UNPOOLED='postgresql://...' \
  WEB_ORIGIN='https://<pages-host>' \
  NEAR_OPERATOR_ACCOUNT='...' \
  NEAR_OPERATOR_PRIVATE_KEY='...'
flyctl deploy --remote-only --ha=false
```

`APP_ENV`, `PGSSL`, `HOST`, `PORT`, `CHAIN_SOURCE_REQUIRED` and
`READINESS_TIMEOUT_MS` are set in `fly.toml`. Add the remaining `NEAR_*` and worker
settings as secrets, and remove `CHAIN_SOURCE_REQUIRED` once an indexer URL is
configured. The `[deploy] release_command` applies migrations with
`DATABASE_URL_UNPOOLED` before the release starts.

Fly's GitHub integration deploys on every push to the connected branch and has no
build-path filter; keep the connection on `main` and merge web work only when an API
redeploy is acceptable. DigitalOcean App Platform can reuse `server/Dockerfile` the
same way.

## Known limitations

- The chain event ingester speaks the documented HTTP contract, but no production indexer URL has been selected or deployed. Until an owner-approved source is configured, staging/production readiness fails and live ingestion does not run; request-time writes and `POST /sync` still keep the mirror current.
- Malformed or unverifiable events block the cursor until an operator runs `npm run chain:failure -- --retry` or `--ignore` with an audited reason.
- `npm run chain:rebuild` is local/test only. It fetches and validates the complete provider history into a connection-local staging table before touching active rows, holds a network/contract advisory lock, replaces only chain-owned derived tables in one transaction, rolls back on any failure, records each run in `rebuild_runs`, and never cascades into server-owned tables. It exits non-zero when canonical supply and the mirrored wallet sum differ.
- Single city plot seed; the schema supports many districts.
- Real-time presence and chat are out of scope; NPC, chain-ingester, job-reconciliation, and quiz-reconciliation workers run in-process.
- Deployed to testnet only. For production, point `DATABASE_URL` at Neon, host the API behind TLS, disable demo mode, and configure `CHAIN_EVENT_SOURCE_URL`. Use the pooled Neon URL for the API and the direct URL for migrations, with `PGSSL=require`.
- Browser profiles can explore without a wallet. Economic actions require a connected, authenticated wallet; public release still requires the deferred deployment/key work.

## Browser-game delivery checks

- `npm run verify`: deterministic formatting, lint, types, fast tests and builds; no database required.
- `npm run test:web`: phone, landing, profile entry, onboarding and management component tests.
- `npm run db:test`: requires a disposable `TEST_DATABASE_URL`; each test creates its own schema.
- `npm run test:coverage --workspace=server`: fast + PostgreSQL + shared tests under one coverage report. It requires `TEST_DATABASE_URL` and keeps the existing 68/88/78 floors. CI runs it in the PostgreSQL job; unit tests themselves remain database-free.
- `npm run test:game:entry`: real Chrome + isolated Fastify/PostgreSQL. Covers signup, NEAR welcome, every phone app, logout, one-click return and reload. Set `CHROME_PATH` outside the default macOS Chrome location.
- `npm run test:game:stack`: native movement, doors, resident interaction and return trips.
- `npm run test:e2e:local`: local NEAR sandbox, real order payment, stock fulfillment, withdrawal, research payout, quiz reward and replay checks.

Migrations `0027`–`0031` add browser profiles, separate residential suites, immutable
research assignments and catalogue/order/stock records. Apply while application
workers are stopped. Existing wallet balances, ownership, accepted/submitted jobs and
venue-hours overrides are preserved. `0029` upgrades only unaccepted NPC job offers.
Opening stock and manually recorded deliveries do not debit QC or fabricate revenue.
Orders hold stock until payment is resolved; unknown transactions are not automatically
released or resubmitted. Supplier settlement, cancellation/refunds and NPC shopping need
their own next-stage workflows.

### Automatic testnet accounts

Username signup supports a separate encrypted, game-managed NEAR testnet wallet
per resident. Enable locally with `npm run db:push` and
`npm run wallets:setup -- --enable`, then restart the API. Players can download a
recovery backup from their phone Wallet app. The wallet setup scripts cover custody,
retries and recovery.
The existing live contract upgrade gate still applies: account creation can finish
and existing saved signup requests have completed against the upgraded contract.

### NEAR learning and friend matches

Inside the quiz centre, open **Phone → Quizzes → Compete**. Choose **Find an
opponent** for automatic pairing at the same stake, or check **List this room
publicly** so other players can browse and join. Private invite rooms remain
available. Searching never spends QC; both players confirm their own deposits. Both players fund their chosen QC stake
into contract escrow; the higher score wins the pot after the 2% centre deduction. Ties and cancelled
or expired lobbies refund confirmed QC deposits including fees. New stakes use 50 QC increments to keep the 2% fee exact in whole QC units.
There is no QC gas-support charge; native NEAR gas is separate. Existing rooms
retain their original quoted terms. Practice questions, research and NPC guidance
teach NEAR using official sources.

Apply `npm run db:push` and restart the server after updating. The administrator
bootstrap for the two empty fee wallets, payment recovery, scoring authority and
test commands are covered by the quiz-match setup script and tests.
