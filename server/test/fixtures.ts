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
    ...overrides,
  };
}
