# QUIZ CITY

A persistent multiplayer city where quiz credits (QC) are real on-chain money. Players prove knowledge, take jobs, buy plots, open venues, and trade businesses. Every balance and ownership claim is enforced by a NEAR smart contract; Postgres is a disposable read model.

Built for the NEAR "Games With Real Economies" hackathon.

- Contract (testnet): [`quizcity.testnet`](https://testnet.nearblocks.io/address/quizcity.testnet)
- Web app: Vite + React (runs at http://localhost:5173)
- API: Fastify at http://localhost:8787

## The loop

1. **Register** — creates your on-chain identity and logical wallet `player:<account>`.
2. **Claim 500 QC** — one-time starter allowance, once per account.
3. **Work** — take a job from Professor Kofi (an NPC with a bounded wallet), finish it, get paid by the NPC, not by minting.
4. **Learn** — pass the daily quiz (6 of 8). Rewards are operator-signed and capped at 1,000 QC per call.
5. **Own** — buy a plot. The contract moves QC and title atomically; a plot cannot have two owners.
6. **Trade** — open a venue (100 QC permit, burned), sell tickets, transfer the business to another player.

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

`pay_job` is operator-only and moves QC from the NPC wallet to the worker via the same internal transfer used by players. Professor Kofi starts with 1,000 QC and pays 100 per job, so he stops hiring when his wallet runs dry. Quiz rewards are the only minted issuance, and they are per-call capped. Both `pay_job` and `credit_reward` require a unique reference, so a retried HTTP request cannot pay twice.

## Repo layout

```
contract/        Rust contract, unit tests, deployable wasm
server/          Fastify API, Postgres schema, sync + operator, scripts
web/             React UI (city grid, jobs, quiz, business, ledger)
```

The ordered implementation plan, audit findings, task dependencies, and acceptance gates are in [`TECHNICAL_WORKFLOW.md`](./TECHNICAL_WORKFLOW.md). Start with Phase 0 and do not skip the backend-complete gate before building the final city art.

## Quick start

Prerequisites: Node 20.20 (see `.nvmrc`), Rust 1.95 (`contract/rust-toolchain.toml`), `cargo-near` 0.23, Postgres 17.

The contract uses `near-sdk` 5.30.1, which declares protocol version 85, so rustc 1.95 builds the WASM and runs the tests. Contract commands must run from `contract/`; `cargo near build --manifest-path` from the repository root uses the root toolchain instead of the pin. The root scripts below run every contract command through `scripts/run-contract.mjs`, and `npm run toolchain:check` verifies the active compiler matches the pin.

```bash
npm ci

# 1. Database and configuration
cp server/.env.example server/.env        # set DATABASE_URL, operator key
# Local demo only: APP_ENV=local, HOST=127.0.0.1, NEAR_NETWORK=testnet, DEMO_MODE=1
createdb quizcity
npm run db:push                       # applies ordered SQL migrations from server/db/migrations/
npm run db:seed                       # demo quiz, job, NPC, and connected world seed (idempotent)
# npm run db:reset requires --confirm-local-reset and APP_ENV=local|test
# npm run db:test runs PostgreSQL integration tests against TEST_DATABASE_URL

# 2. Contract checks (only needed if you change the contract)
npm run contract:test                     # 49 unit tests
npm run contract:fmt:check
npm run contract:clippy                   # includes the demo-reset feature
npm run contract:build                    # production WASM, no demo helpers

# 3. Deploy + seed the disposable testnet demo state
#    Builds the demo artifact, verifies it exposes both demo helpers, then
#    deploys, calls migrate_reset, and seeds NPC/plot.
NEAR_DEPLOY_PRIVATE_KEY=<contract-account-full-access-key> npm run chain:seed

# 4. Read model
npm run db:reset && npm run db:seed

# 5. Run
npm run dev                               # API :8787, web :5173
```

`.env` keys: `APP_ENV`, `DEMO_MODE`, `DATABASE_URL`, `PGSSL`, `PORT`, `HOST`, `WEB_ORIGIN`, `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_CONTRACT_ID`, `NEAR_OPERATOR_ACCOUNT`, `NEAR_OPERATOR_PRIVATE_KEY`, `NPC_TICK_MS`, `E2E_API`, and the chain/readiness worker settings (`CHAIN_EVENT_SOURCE_URL`, `CHAIN_SOURCE_REQUIRED`, `CHAIN_START_BLOCK`, `CHAIN_POLL_INTERVAL_MS`, `CHAIN_PAGE_SIZE`, `CHAIN_FETCH_TIMEOUT_MS`, `CHAIN_MAX_RETRIES`, `READINESS_TIMEOUT_MS`). See [`docs/chain-ingestion.md`](./docs/chain-ingestion.md). Staging and production refuse to start without a chain event source unless `CHAIN_SOURCE_REQUIRED=0` is set explicitly. Configuration is validated once at startup; invalid or missing values stop the process with an actionable message and a redacted summary is logged. Tests import the pure validator and need no `.env`.

`NEAR_OPERATOR_PRIVATE_KEY` is a payout-only function-call key for `credit_reward` and `pay_job`. `NEAR_DEPLOY_PRIVATE_KEY` is the contract account's offline full-access deploy/recovery key and is required only for `npm run chain:seed`; pass it in the shell and never store it in `server/.env`.

Use `https://rpc.testnet.fastnear.com`; the public `rpc.testnet.near.org` endpoint is rate-limited and returns 429s.

## Demo walkthrough

1. Sign in as `alice-quizcity.testnet` (demo keys are served only when `DEMO_MODE=1`).
2. Register → claim 500 → accept and complete Professor Kofi's job (+100).
3. Play the daily quiz (+25 on a pass, once per day).
4. Buy plot `#1` for 300 QC.
5. Open a venue on the plot (−100 permit) and pay a 20 QC ticket as `bob-quizcity.testnet`.
6. Transfer the venue to Bob from Alice's business panel.
7. After the job is paid, the NPC tick posts a fresh job within ~20s — the city keeps hiring as long as Kofi has QC.

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
| `business_withdraw(id, amount)`                                           | owner                       | Owner-only treasury withdrawal                         |
| `transfer_business(id, new_owner)`                                        | owner                       | Moves the operating company only                       |
| `set_paused(paused)` / `propose_operator` / `accept_operator`             | operator                    | Pause payouts; two-step operator rotation              |
| `is_reference_processed(reference)`                                       | anyone                      | Payout reconciliation view                             |
| `reset_demo` / `migrate_reset`                                            | operator / contract account | Demo-reset build only; `migrate_reset` is `#[private]` |
| `get_balance / get_player / get_property / get_business / get_stats`      | anyone                      | Single-entity views                                    |
| `get_properties(from_index, limit)` / `get_businesses(from_index, limit)` | anyone                      | Pages of up to 100 items                               |

State-changing methods emit canonical NEP-297-style `EVENT_JSON` logs. Each ledger movement has one event with `seq`, `wallet_from`, `wallet_to`, `amount`, `reference`, and `entity_id`; see [`docs/contract-events.md`](./docs/contract-events.md). The server reads those events for amounts and parties instead of trusting the request body.

## Server API

`GET /health/live` · `GET /health/ready` · `GET /v1/config` · `GET /v1/demo/accounts` · `GET /v1/players/:account` · `GET /v1/jobs` · `GET /v1/npcs` · `GET /v1/quizzes` · `GET /v1/transactions` · `GET /v1/snapshots` · `GET /v1/contract/stats` · `GET /v1/auth/me`

`POST /v1/auth/nonce` · `POST /v1/auth/verify` · `POST /v1/auth/logout` · `POST /v1/players/register` · `POST /v1/players/claim` · `POST /v1/jobs/:id/accept` · `POST /v1/jobs/:id/submit` · `POST /v1/jobs/:id/verify` · `POST /v1/jobs/:id/complete` · `POST /v1/jobs/:id/retry-payment` · `POST /v1/quizzes/:id/start` · `POST /v1/quizzes/:id/submit` · `POST /v1/properties/:id/buy` · `POST /v1/businesses` · `POST /v1/businesses/:id/pay` · `POST /v1/businesses/:id/transfer` · `POST /v1/sync`

All mutating routes require an authenticated session plus the `x-csrf-token` header. Identity comes from the session cookie; request bodies never supply `accountId`.

Sign-in implements NEP-413. `POST /v1/auth/nonce` returns the application message, a 32-byte nonce (base64 transport), the contract recipient, and the configured callback URL. The client decodes the nonce to 32 bytes and calls the wallet's standard `signMessage({ message, recipient, nonce, callbackUrl })`; the wallet signs `SHA256(Borsh(u32(2147484061)) || Borsh({message,nonce,recipient,callbackUrl}))`. `POST /v1/auth/verify` validates the nonce encoding, re-derives the same digest from stored issued/expiry times, requires the submitted key to have `FullAccess` permission (function-call keys cannot log in), verifies the signature, and only then consumes the nonce and creates the session. Raw-JSON signatures do not verify. The local demo signer computes the same digest, so demo and production share one protocol.

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever `APP_ENV` is staging/production or `WEB_ORIGIN` is HTTPS — proxy TLS termination is therefore safe. `/jobs/:id/retry-payment` is operator/admin only.

QC amounts are canonical decimal strings, never JavaScript numbers. Validation failures and application errors use one envelope: `{"error":{"code","message","requestId","details"}}`. Fastify validation runs from TypeBox schemas (including a `qc-amount` format that rejects U128 max + 1 before the handler), and OpenAPI is served at `/documentation` only when `APP_ENV=local` or `ENABLE_API_DOCS=1`. Lists return `{items, nextCursor}`; `/health/live` and `/health/ready` are the only stable non-versioned routes. `/health/ready` checks PostgreSQL, a contract view, and the configured indexer independently, each with a timeout, and returns safe `checks` statuses plus 503 when a required dependency fails. `/health/live` performs no dependency I/O. Job verification and `/sync` require an `operator` or `admin` role; grant local/test roles with `npm run role:grant -- --account <id> --role <role> --confirm-grant-role`.

## Tests

```bash
npm run verify                             # all checks listed below
npm run db:test                            # PostgreSQL integration tests (TEST_DATABASE_URL, temporary schemas)
npm run e2e                                # full player loop against testnet
npm run exploit                            # 13 adversarial checks (mutates demo state)
```

`npm run verify` runs the production contract tests (49), demo-reset contract tests (52), 125 server tests, the toolchain and WASM-export checker tests, formatting/linting/typechecks, both builds, and a production-WASM check that reads real function exports and rejects demo helpers. `npm run db:test` executes 113 PostgreSQL integration tests for migrations, ledger atomicity/conflict behavior, NEP-413 auth, transaction consumption, quiz snapshots, job payment races/reconciliation, chain ingestion/rebuild/dead-letter handling, readiness, sync, and the world seed against disposable schemas.

`e2e` and `exploit` mutate testnet state. They are intentionally deferred while the Phase 1 live deployment/key work remains owner-gated; do not treat them as current evidence until the corrected contract is deployed and approved.

`e2e` drives register → claim → job → quiz → property → business → transfer and asserts exact balances. `exploit` mutates demo state, so reset afterwards (below). It covers forged hashes, cross-account transaction use, SQL injection in paths, answer leakage, quiz replay, non-employee job completion, request-tampered payment amounts, demo-key leakage, and ledger duplication.

Expected end state: Alice 225 QC, Bob 480 QC, Kofi 1,200 QC (900 after the job + 300 property sale), venue treasury 20 QC, council 0.

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
- Demo sign-in uses disposable testnet keys in `localStorage` and is only reachable through `DEMO_MODE=1`. Server-side auth is a real NEP-413 Borsh/prefix/SHA-256 signature check over one-time, domain/network-bound nonces; only full-access keys can authenticate. The full wallet-selector UX is still deferred (QC-0502), so non-demo browser deployments remain read-only until then.
- `DEMO_MODE` defaults to `0`; configuration omission cannot expose keys.
- The Postgres mirror can be wiped and rebuilt with `POST /sync` / `npm run db:reset`; it holds no authority.
- `reset_demo` is operator-gated; `migrate_reset` is `#[private]` and callable only by the contract account. Both exist only in the `demo-reset` build. Production builds do not export them.
- Operator payouts are capped per call, total supply is capped, and `credit_reward`/`pay_job` reject reused references. The operator can pause payouts without blocking reads; rotation is two-step (`propose_operator` then `accept_operator` from the new account).
- `npm run payout-key:verify` fails a server key that is `FullAccess`, targets another contract, allows extra methods, or has no allowance. Keep the contract account's full-access deploy/recovery key offline; only `chain:seed` needs it, via `NEAR_DEPLOY_PRIVATE_KEY` supplied in the shell.

## Repository checks

```bash
npm run verify
```

In order: Rust toolchain pin check; Prettier and `cargo fmt --check`; ESLint (runtime-specific globals) and `cargo clippy -D warnings`; TypeScript for server and web; 49 production contract tests, 52 demo-reset contract tests, 125 server tests, and the toolchain/WASM-export checker tests; then the contract WASM, server typecheck, and production web build; finally the production-WASM demo-helper check, which inspects `WebAssembly.Module.exports` rather than raw bytes. `npm ci && npm run verify` works without `server/.env`.

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

## Known limitations

- The chain event ingester speaks the documented HTTP contract in [`docs/chain-ingestion.md`](./docs/chain-ingestion.md), but no production indexer URL has been selected or deployed. Until an owner-approved source is configured, staging/production readiness fails and live ingestion does not run; request-time writes and `POST /sync` still keep the mirror current.
- Malformed or unverifiable events block the cursor until an operator runs `npm run chain:failure -- --retry` or `--ignore` with an audited reason.
- `npm run chain:rebuild` is local/test only. It fetches and validates the complete provider history into a connection-local staging table before touching active rows, holds a network/contract advisory lock, replaces only chain-owned derived tables in one transaction, rolls back on any failure, records each run in `rebuild_runs`, and never cascades into server-owned tables. It exits non-zero when canonical supply and the mirrored wallet sum differ.
- Single city plot seed; the schema supports many districts.
- Real-time presence and chat are out of scope; NPC, chain-ingester, job-reconciliation, and quiz-reconciliation workers run in-process.
- Deployed to testnet only. For production, point `DATABASE_URL` at Neon, host the API behind TLS, disable demo mode, and configure `CHAIN_EVENT_SOURCE_URL`.
- The full browser wallet-selector UX is still deferred (QC-0502); non-demo browser deployments are read-only. The server-side signed-message login path is implemented.
