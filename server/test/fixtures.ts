import { KeyPair } from "near-api-js";
import type { AppConfig } from "../src/config.js";

// Generated per run so no private-key material is stored in the repository.
const disposable = KeyPair.fromRandom("ed25519");
export const TEST_PRIVATE_KEY = disposable.toString();
export const TEST_PUBLIC_KEY = disposable.getPublicKey().toString();

export const testEnv: NodeJS.ProcessEnv = {
  APP_ENV: "test",
  DEMO_MODE: "0",
  DATABASE_URL: "postgresql://quizcity:quizcity@localhost:5432/quizcity",
  PGSSL: "disable",
  PORT: "8787",
  HOST: "127.0.0.1",
  WEB_ORIGIN: "http://localhost:5173",
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
  NEAR_CONTRACT_ID: "quizcity.testnet",
  NEAR_OPERATOR_ACCOUNT: "quizcity.testnet",
  NEAR_OPERATOR_PRIVATE_KEY: TEST_PRIVATE_KEY,
  NPC_TICK_MS: "20000",
  CHAIN_SOURCE_REQUIRED: "0",
  E2E_API: "http://localhost:8787",
};

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appEnv: "test",
    demoMode: false,
    demoAccountsFile: null,
    port: 8787,
    host: "127.0.0.1",
    webOrigin: "http://localhost:5173",
    databaseUrl: "postgresql://quizcity:quizcity@localhost:5432/quizcity",
    pgSsl: "disable",
    networkId: "testnet",
    rpcUrl: "https://rpc.testnet.fastnear.com",
    contractId: "quizcity.testnet",
    operatorAccount: "quizcity.testnet",
    operatorPrivateKey: TEST_PRIVATE_KEY,
    npcTickMs: 20_000,
    e2eApi: "http://localhost:8787",
    enableApiDocs: false,
    bodyLimit: 65_536,
    rateLimitMax: 120,
    rateLimitWindowMs: 60_000,
    trustProxy: false,
    shutdownTimeoutMs: 10_000,
    readinessTimeoutMs: 2_000,
    chainEventSourceUrl: null,
    chainStartBlock: null,
    chainSourceRequired: false,
    chainPollIntervalMs: 15_000,
    chainPageSize: 100,
    chainFetchTimeoutMs: 5_000,
    chainMaxRetries: 3,
    worldSocketMaxPayloadBytes: 16_384,
    worldHeartbeatMs: 30_000,
    worldHeartbeatTimeoutMs: 75_000,
    worldMaxSocketsPerAccount: 3,
    worldMaxSocketsPerIp: 20,
    worldMaxQueuedBytes: 1_048_576,
    worldReplayLimit: 200,
    worldPresenceTimeoutMs: 60_000,
    worldFanoutPollMs: 1_000,
    worldTickMs: 1_000,
    worldTilesPerTick: 1,
    worldMoveCooldownMs: 250,
    worldMoveBurst: 4,
    worldInteractionCooldownMs: 500,
    worldInteractionBurst: 2,
    ...overrides,
  };
}
