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
npm run db:push

# 2. Contract checks (only needed if you change the contract)
npm run contract:test                     # 44 unit tests
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

`.env` keys: `APP_ENV`, `DEMO_MODE`, `DATABASE_URL`, `PGSSL`, `PORT`, `HOST`, `WEB_ORIGIN`, `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_CONTRACT_ID`, `NEAR_OPERATOR_ACCOUNT`, `NEAR_OPERATOR_PRIVATE_KEY`, `NPC_TICK_MS`, `E2E_API`. Configuration is validated once at startup; invalid or missing values stop the process with an actionable message and a redacted summary is logged. Tests import the pure validator and need no `.env`.

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

`GET /config` · `GET /demo/accounts` · `GET /players/:account` · `GET /jobs` · `GET /npcs` · `GET /quizzes` · `GET /transactions` · `GET /snapshots` · `GET /contract/stats`

`POST /players/register` · `POST /players/claim` · `POST /jobs/:id/accept` · `POST /jobs/:id/complete` · `POST /quizzes/:id/start` · `POST /quizzes/:id/submit` · `POST /properties/:id/buy` · `POST /businesses` · `POST /businesses/:id/pay` · `POST /businesses/:id/transfer` · `POST /sync`

All mutating routes require a `txHash` (and an `accountId` where relevant).

## Tests

```bash
npm run verify                             # all checks listed below
npm run e2e                                # full player loop against testnet
npm run exploit                            # 13 adversarial checks (mutates demo state)
```

`npm run verify` runs the production contract tests (49), demo-reset contract tests (52), 57 server tests, the toolchain and WASM-export checker tests, formatting/linting/typechecks, both builds, and a production-WASM check that reads real function exports and rejects demo helpers.

`e2e` drives register → claim → job → quiz → property → business → transfer and asserts exact balances. `exploit` mutates demo state, so reset afterwards (below). It covers forged hashes, cross-account transaction use, SQL injection in paths, answer leakage, quiz replay, non-employee job completion, request-tampered payment amounts, demo-key leakage, and ledger duplication.

Expected end state: Alice 225 QC, Bob 480 QC, Kofi 1,200 QC (900 after the job + 300 property sale), venue treasury 20 QC, council 0.

## Reset

```bash
npm run contract:build:demo   # demo build includes migrate_reset
NEAR_DEPLOY_PRIVATE_KEY=<contract-account-full-access-key> npm run chain:seed
npm run db:reset              # drop/apply schema
npm run db:seed               # quiz, job, NPC rows
```

The root `chain:seed` script rebuilds the demo artifact, runs the demo ABI check, prints its SHA-256, and refuses to deploy a WASM that lacks `migrate_reset`/`reset_demo`. `migrate_reset` is `#[private]`: only the contract account can call it, and the migrated operator is the contract account. The demo build is disposable. `migrate_reset` writes fresh collection prefixes, so prior demo entries are orphaned rather than migrated. Production builds omit `reset_demo` and `migrate_reset`; the verify step asserts this against the WASM.

## Demo mode and key rotation

Demo sign-in is opt-in and local-demo-only. `DEMO_MODE=1` is accepted only when all of these hold:

- `APP_ENV=local` or `test`
- `NEAR_NETWORK=testnet`
- `HOST` is loopback (`127.0.0.1`, `localhost`, or `::1`)

With the flag absent or `0`, `GET /demo/accounts` returns 404, the web client renders a read-only notice, and no account picker is mounted. The route also refuses to load keys unless the full configuration is safe (503 on an impossible unsafe override), filtering the operator account, the contract account, and any entry whose secret matches the operator key. Startup fails if the operator account or key is missing. Real wallet sign-in is intentionally not implemented yet (QC-0502), so non-demo deployments are read-only.

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
- Demo sign-in uses disposable testnet keys in `localStorage`. This is a demo convenience, not a production auth pattern — production would use a wallet selector with the user's own signer (QC-0502). Non-demo deployments are read-only until then.
- `DEMO_MODE` defaults to `0`; configuration omission cannot expose keys.
- The Postgres mirror can be wiped and rebuilt with `POST /sync` / `npm run db:reset`; it holds no authority.
- `reset_demo` is operator-gated; `migrate_reset` is `#[private]` and callable only by the contract account. Both exist only in the `demo-reset` build. Production builds do not export them.
- Operator payouts are capped per call, total supply is capped, and `credit_reward`/`pay_job` reject reused references. The operator can pause payouts without blocking reads; rotation is two-step (`propose_operator` then `accept_operator` from the new account).
- `npm run payout-key:verify` fails a server key that is `FullAccess`, targets another contract, allows extra methods, or has no allowance. Keep the contract account's full-access deploy/recovery key offline; only `chain:seed` needs it, via `NEAR_DEPLOY_PRIVATE_KEY` supplied in the shell.

## Repository checks

```bash
npm run verify
```

In order: Rust toolchain pin check; Prettier and `cargo fmt --check`; ESLint (runtime-specific globals) and `cargo clippy -D warnings`; TypeScript for server and web; 49 production contract tests, 52 demo-reset contract tests, 57 server tests, and the toolchain/WASM-export checker tests; then the contract WASM, server typecheck, and production web build; finally the production-WASM demo-helper check, which inspects `WebAssembly.Module.exports` rather than raw bytes. `npm ci && npm run verify` works without `server/.env`.

The same command runs in `.github/workflows/verify.yml` on Node 20.20 and Rust 1.95, with the WASM checksum recorded as an artifact.

## Known limitations

- No event indexer; the mirror refreshes from views on write and every 10s. `POST /sync` catches anything missed.
- Single city plot seed; the schema supports many districts.
- Real-time presence and chat are out of scope; the NPC tick is the only autonomous actor.
- Deployed to testnet only. For production, point `DATABASE_URL` at Neon, host the API behind TLS, and disable demo mode.
- No wallet-selector sign-in yet; non-demo deployments are read-only (QC-0502).
