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

Running totals (`total_issued`, `total_burned`, `tx_count`) are on chain, so the economy is auditable rather than asserted.

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

`pay_job` is operator-only and moves QC from the NPC wallet to the worker via the same internal transfer used by players. Professor Kofi starts with 1,000 QC and pays 100 per job, so he stops hiring when his wallet runs dry. Quiz rewards are the only minted issuance, and they are per-call capped.

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
npm run contract:test                     # 13 unit tests
npm run contract:fmt:check
npm run contract:clippy
npm run contract:build

# 3. Deploy + seed the testnet state
npm run chain:seed                        # deploy, reset_demo, seed NPC/plot

# 4. Read model
npm run db:reset && npm run db:seed

# 5. Run
npm run dev                               # API :8787, web :5173
```

`.env` keys: `APP_ENV`, `DEMO_MODE`, `DATABASE_URL`, `PGSSL`, `PORT`, `HOST`, `WEB_ORIGIN`, `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_CONTRACT_ID`, `NEAR_OPERATOR_ACCOUNT`, `NEAR_OPERATOR_PRIVATE_KEY`, `NPC_TICK_MS`, `E2E_API`. Configuration is validated once at startup; invalid or missing values stop the process with an actionable message and a redacted summary is logged. Tests import the pure validator and need no `.env`.

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

| Method                                                                      | Who             | Effect                                  |
| --------------------------------------------------------------------------- | --------------- | --------------------------------------- |
| `register_player(username)`                                                 | anyone          | Creates `player:<account>` with 0 QC    |
| `claim_starter()`                                                           | player          | One-time 500 QC, tracked on chain       |
| `transfer_qc(to_wallet, amount)`                                            | wallet owner    | Internal transfer, positive amount only |
| `credit_reward(wallet, amount, reference)`                                  | operator        | Mints capped at 1,000 per call          |
| `pay_job(employer, employee, amount, reference)`                            | operator        | Moves QC from NPC/business budget       |
| `create_property(district, x, y, price)`                                    | operator/seeder | Mints a titled plot                     |
| `list_property(id, price)`                                                  | owner           | Lists a plot for sale                   |
| `buy_property(id)`                                                          | any player      | Atomic QC + title swap; no self-buy     |
| `create_business(property_id, name)`                                        | plot owner      | 100 QC permit, burned                   |
| `pay_service(business_id, amount)`                                          | customer        | Pays the business treasury              |
| `business_withdraw(id, amount)`                                             | owner           | Owner-only treasury withdrawal          |
| `transfer_business(id, new_owner)`                                          | owner           | Moves the venue and its treasury        |
| `reset_demo()`                                                              | operator        | Testnet-only state wipe                 |
| `get_balance / get_player / get_property(s) / get_business(es) / get_stats` | anyone          | Views                                   |

State-changing methods emit NEP-297-style `EVENT_JSON` logs (`transfer`, `job_reward`, `service_paid`), which the server uses as the source of truth for amounts and parties.

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

`e2e` drives register → claim → job → quiz → property → business → transfer and asserts exact balances. `exploit` mutates demo state, so run `npm run chain:seed && npm run db:reset && npm run db:seed` afterwards. It covers forged hashes, cross-account transaction use, SQL injection in paths, answer leakage, quiz replay, non-employee job completion, request-tampered payment amounts, demo-key leakage, and ledger duplication.

Expected end state: Alice 225 QC, Bob 480 QC, Kofi 1,200 QC (900 after the job + 300 property sale), venue treasury 20 QC, council 0.

## Reset

```bash
npm run chain:seed    # reset_demo + reseed NPC wallet and plot
npm run db:reset      # drop/apply schema
npm run db:seed       # quiz, job, NPC rows
```

## Demo mode and key rotation

Demo sign-in is opt-in and local-demo-only. `DEMO_MODE=1` is accepted only when all of these hold:

- `APP_ENV=local` or `test`
- `NEAR_NETWORK=testnet`
- `HOST` is loopback (`127.0.0.1`, `localhost`, or `::1`)

With the flag absent or `0`, `GET /demo/accounts` returns 404, the web client renders a read-only notice, and no account picker is mounted. The route also refuses to load keys unless the full configuration is safe (503 on an impossible unsafe override), filtering the operator account, the contract account, and any entry whose secret matches the operator key. Startup fails if the operator account or key is missing. Real wallet sign-in is intentionally not implemented yet (QC-0502), so non-demo deployments are read-only.

Demo credentials are disposable testnet keys stored in `localStorage`. Rotation is dry-run by default:

```bash
npm run keys:rotate:dry-run   # lists account IDs and current public keys, changes nothing
npm run keys:rotate           # requires --confirm-testnet-rotation under the hood
```

The confirmed run requires `APP_ENV=local|test`, testnet, and `DEMO_MODE=1`. It writes timestamped backups of `.env` and `demo-accounts.json` to `server/backups/<timestamp>/` (mode 0600, Git-ignored), adds the new key, confirms it on-chain, persists it, and only then deletes the old key. It removes operator entries by account ID, not by JSON key name. If any step fails it stops immediately and prints the backup path, account IDs, and public keys only. Restore from the backup if the new secret was not persisted. Do not print or commit private keys.

## Security notes

- The operator key lives only in the server environment. It is never sent to the browser and `/demo/accounts` filters it out.
- Demo sign-in uses disposable testnet keys in `localStorage`. This is a demo convenience, not a production auth pattern — production would use a wallet selector with the user's own signer (QC-0502). Non-demo deployments are read-only until then.
- `DEMO_MODE` defaults to `0`; configuration omission cannot expose keys.
- The Postgres mirror can be wiped and rebuilt with `POST /sync` / `npm run db:reset`; it holds no authority.
- `reset_demo` is a testnet-only escape hatch and is operator-gated.

## Repository checks

```bash
npm run verify
```

In order: Rust toolchain pin check; Prettier and `cargo fmt --check`; ESLint (runtime-specific globals) and `cargo clippy -D warnings`; TypeScript for server and web; 13 contract tests, 21 server tests, and the toolchain-checker tests; then the contract WASM, server typecheck, and production web build. `npm ci && npm run verify` works without `server/.env`.

The same command runs in `.github/workflows/verify.yml` on Node 20.20 and Rust 1.95, with the WASM checksum recorded as an artifact.

## Known limitations

- No event indexer; the mirror refreshes from views on write and every 10s. `POST /sync` catches anything missed.
- Single city plot seed; the schema supports many districts.
- Real-time presence and chat are out of scope; the NPC tick is the only autonomous actor.
- Deployed to testnet only. For production, point `DATABASE_URL` at Neon, host the API behind TLS, and disable demo mode.
- No wallet-selector sign-in yet; non-demo deployments are read-only (QC-0502).
