import { KeyPair } from "near-api-js";

export type AppEnv = "local" | "test" | "staging" | "production";

export type AppConfig = {
  appEnv: AppEnv;
  demoMode: boolean;
  autoTestnetWallets: boolean;
  testnetWalletEncryptionKey: string | null;
  testnetWalletFaucetUrl: string;
  testnetWalletDailyLimit: number;
  testnetWalletAccountSuffix: string;
  demoAccountsFile: string | null;
  port: number;
  host: string;
  webOrigin: string;
  databaseUrl: string;
  pgSsl: "disable" | "require";
  networkId: "testnet" | "mainnet";
  rpcUrl: string;
  contractId: string;
  operatorAccount: string;
  operatorPrivateKey: string;
  npcTickMs: number;
  cityTimezone: string;
  npcSimulationTickMs: number;
  npcSimulationCatchupMs: number;
  e2eApi: string;
  enableApiDocs: boolean;
  bodyLimit: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  trustProxy: boolean;
  shutdownTimeoutMs: number;
  readinessTimeoutMs: number;
  chainEventSourceUrl: string | null;
  chainStartBlock: string | null;
  chainSourceRequired: boolean;
  chainPollIntervalMs: number;
  chainPageSize: number;
  chainFetchTimeoutMs: number;
  chainMaxRetries: number;
  worldSocketMaxPayloadBytes: number;
  worldHeartbeatMs: number;
  worldHeartbeatTimeoutMs: number;
  worldMaxSocketsPerAccount: number;
  worldMaxSocketsPerIp: number;
  worldMaxQueuedBytes: number;
  worldReplayLimit: number;
  worldPresenceTimeoutMs: number;
  worldFanoutPollMs: number;
  worldTickMs: number;
  worldTilesPerTick: number;
  worldMoveCooldownMs: number;
  worldMoveBurst: number;
  worldInteractionCooldownMs: number;
  worldInteractionBurst: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(`invalid configuration: ${message}`);
    this.name = "ConfigError";
  }
}

const IMPLICIT_RE = /^[0-9a-f]{64}$/;
const APP_ENVS: AppEnv[] = ["local", "test", "staging", "production"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Account IDs are 2-64 characters of lowercase alphanumerics with `.`, `_`, and `-`
 * separators. Separators must sit between alphanumeric groups: no leading, trailing,
 * or repeated separators. A 64-character lowercase hex implicit account is valid.
 */
export function isValidAccountId(value: string): boolean {
  if (IMPLICIT_RE.test(value)) return true;
  if (value.length < 2 || value.length > 64) return false;
  if (!/^[a-z0-9._-]+$/.test(value)) return false;
  if (/^[._-]|[._-]$/.test(value)) return false;
  if (/[._-]{2,}/.test(value)) return false;
  return /[a-z0-9]/.test(value);
}

export function assertDemoConfigurationIsSafe(
  config: Pick<AppConfig, "demoMode" | "appEnv" | "networkId" | "host">,
): void {
  if (!config.demoMode) return;
  if (config.appEnv === "production") {
    throw new ConfigError("DEMO_MODE must be 0 when APP_ENV=production");
  }
  if (config.appEnv !== "local" && config.appEnv !== "test") {
    throw new ConfigError("DEMO_MODE=1 is allowed only for APP_ENV=local or test");
  }
  if (config.networkId !== "testnet") {
    throw new ConfigError("DEMO_MODE=1 is allowed only on testnet");
  }
  if (!isLoopbackHost(config.host)) {
    throw new ConfigError("DEMO_MODE=1 requires a loopback HOST");
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required (copy server/.env.example to server/.env)`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string, fallback: string): URL {
  const raw = env[name]?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL`);
  }
  const local = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new ConfigError(`${name} must use https (http is allowed only for loopback hosts)`);
  }
  return parsed;
}

function hostValue(env: NodeJS.ProcessEnv): string {
  const raw = env.HOST ?? "127.0.0.1";
  const value = raw.trim();
  if (!value) throw new ConfigError("HOST must not be empty");
  if (/\s|[/\\]/.test(value) || value.includes("://")) {
    throw new ConfigError("HOST must be a hostname or address without a scheme or path");
  }
  return value;
}

function account(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isValidAccountId(value)) {
    throw new ConfigError(`${name} is not a valid NEAR account ID`);
  }
  return value;
}

function assertEnvironmentAccount(name: string, accountId: string, networkId: string): void {
  if (IMPLICIT_RE.test(accountId)) return;
  if (networkId === "testnet" && !accountId.endsWith(".testnet") && !accountId.endsWith(".test.near")) {
    throw new ConfigError(`${name} "${accountId}" does not belong to testnet`);
  }
  if (networkId === "mainnet" && !accountId.endsWith(".near") && !accountId.endsWith(".tg")) {
    throw new ConfigError(`${name} "${accountId}" does not belong to mainnet`);
  }
}

function privateKey(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
    throw new ConfigError(`${name} must be an ed25519 or secp256k1 private key`);
  }
  try {
    KeyPair.fromString(value as Parameters<typeof KeyPair.fromString>[0]);
  } catch {
    throw new ConfigError(`${name} cannot be parsed as a NEAR private key`);
  }
  return value;
}

function databaseUrl(env: NodeJS.ProcessEnv, appEnv: AppEnv): string {
  const raw = required(env, "DATABASE_URL");
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) {
    throw new ConfigError("DATABASE_URL contains a malformed percent escape");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("DATABASE_URL must be a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ConfigError("DATABASE_URL must use the postgres:// or postgresql:// scheme");
  }
  if (!parsed.hostname) throw new ConfigError("DATABASE_URL must include a hostname");
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new ConfigError("DATABASE_URL must include a database name");
  }
  if ((appEnv === "staging" || appEnv === "production") && (!parsed.username || !parsed.password)) {
    throw new ConfigError("DATABASE_URL must include credentials for staging and production");
  }
  return raw;
}

function webOrigin(env: NodeJS.ProcessEnv, appEnv: AppEnv): string {
  const parsed = url(env, "WEB_ORIGIN", "http://localhost:5173");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError("WEB_ORIGIN must be an origin without credentials, query, or hash");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ConfigError("WEB_ORIGIN must not include a path");
  }
  if ((appEnv === "staging" || appEnv === "production") && parsed.protocol !== "https:") {
    throw new ConfigError("WEB_ORIGIN must use https for staging and production");
  }
  return parsed.origin;
}

function canonicalUint(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ConfigError(`${name} must be a canonical non-negative decimal string`);
  }
  return raw;
}

function timeZone(env: NodeJS.ProcessEnv): string {
  const value = env.CITY_TIMEZONE?.trim() || "Africa/Accra";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(new Date());
  } catch {
    throw new ConfigError("CITY_TIMEZONE must be a valid IANA timezone");
  }
  return value;
}

function appEnvironment(env: NodeJS.ProcessEnv): AppEnv {
  const raw =
    env.APP_ENV?.trim() ||
    (env.NODE_ENV === "test" ? "test" : env.NODE_ENV === "production" ? "production" : "local");
  if (!APP_ENVS.includes(raw as AppEnv)) {
    throw new ConfigError(`APP_ENV must be one of ${APP_ENVS.join(", ")}`);
  }
  return raw as AppEnv;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const appEnv = appEnvironment(env);
  if (env.AUTO_TESTNET_WALLETS !== undefined && !["0", "1"].includes(env.AUTO_TESTNET_WALLETS.trim()))
    throw new ConfigError("AUTO_TESTNET_WALLETS must be 0 or 1");

  const demoRaw = env.DEMO_MODE?.trim() ?? "0";
  if (demoRaw !== "0" && demoRaw !== "1") {
    throw new ConfigError("DEMO_MODE must be 0 or 1");
  }
  const demoMode = demoRaw === "1";

  const networkRaw = (env.NEAR_NETWORK ?? "testnet").trim();
  if (networkRaw !== "testnet" && networkRaw !== "mainnet") {
    throw new ConfigError("NEAR_NETWORK must be testnet or mainnet");
  }
  const networkId = networkRaw;

  const host = hostValue(env);
  assertDemoConfigurationIsSafe({ demoMode, appEnv, networkId, host });

  const contractId = account(env, "NEAR_CONTRACT_ID");
  const operatorAccount = account(env, "NEAR_OPERATOR_ACCOUNT");
  assertEnvironmentAccount("NEAR_CONTRACT_ID", contractId, networkId);
  assertEnvironmentAccount("NEAR_OPERATOR_ACCOUNT", operatorAccount, networkId);

  const pgSslRaw = (env.PGSSL ?? "disable").trim();
  if (pgSslRaw !== "disable" && pgSslRaw !== "require") {
    throw new ConfigError("PGSSL must be disable or require");
  }
  if ((appEnv === "staging" || appEnv === "production") && pgSslRaw !== "require") {
    throw new ConfigError("PGSSL must be require for staging and production");
  }

  const chainRequiredRaw = env.CHAIN_SOURCE_REQUIRED?.trim();
  const chainSourceRequired =
    chainRequiredRaw === "1" ||
    (chainRequiredRaw !== "0" && (appEnv === "staging" || appEnv === "production"));

  const rpcFallback =
    networkId === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";

  const config: AppConfig = {
    appEnv,
    demoMode,
    autoTestnetWallets: env.AUTO_TESTNET_WALLETS?.trim() === "1",
    testnetWalletEncryptionKey: optional(env, "TESTNET_WALLET_ENCRYPTION_KEY"),
    testnetWalletFaucetUrl: url(
      env,
      "TESTNET_WALLET_FAUCET_URL",
      "https://helper.nearprotocol.com/account",
    ).toString(),
    testnetWalletAccountSuffix: env.TESTNET_WALLET_ACCOUNT_SUFFIX?.trim() || "testnet",
    testnetWalletDailyLimit: integer(env, "TESTNET_WALLET_DAILY_LIMIT", 8, 1, 100),
    demoAccountsFile: optional(env, "DEMO_ACCOUNTS_FILE"),
    port: integer(env, "PORT", 8787, 1, 65_535),
    host,
    webOrigin: webOrigin(env, appEnv),
    databaseUrl: databaseUrl(env, appEnv),
    pgSsl: pgSslRaw,
    networkId,
    rpcUrl: url(env, "NEAR_RPC_URL", rpcFallback).toString(),
    contractId,
    operatorAccount,
    operatorPrivateKey: privateKey(env, "NEAR_OPERATOR_PRIVATE_KEY"),
    npcTickMs: integer(env, "NPC_TICK_MS", 30_000, 1_000, 3_600_000),
    cityTimezone: timeZone(env),
    npcSimulationTickMs: integer(env, "NPC_SIMULATION_TICK_MS", 1_000, 100, 60_000),
    npcSimulationCatchupMs: integer(env, "NPC_SIMULATION_CATCHUP_MS", 300_000, 1_000, 86_400_000),
    e2eApi: url(env, "E2E_API", "http://localhost:8787").toString().replace(/\/+$/, ""),
    enableApiDocs: env.ENABLE_API_DOCS === "1",
    bodyLimit: integer(env, "BODY_LIMIT", 65_536, 1_024, 1_048_576),
    rateLimitMax: integer(env, "RATE_LIMIT_MAX", 120, 1, 10_000),
    rateLimitWindowMs: integer(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    trustProxy: env.TRUST_PROXY === "1",
    shutdownTimeoutMs: integer(env, "SHUTDOWN_TIMEOUT_MS", 10_000, 1_000, 60_000),
    readinessTimeoutMs: integer(env, "READINESS_TIMEOUT_MS", 2_000, 250, 10_000),
    chainEventSourceUrl: optional(env, "CHAIN_EVENT_SOURCE_URL"),
    chainStartBlock: canonicalUint(env, "CHAIN_START_BLOCK"),
    chainSourceRequired,
    chainPollIntervalMs: integer(env, "CHAIN_POLL_INTERVAL_MS", 15_000, 5_000, 600_000),
    chainPageSize: integer(env, "CHAIN_PAGE_SIZE", 100, 1, 1_000),
    chainFetchTimeoutMs: integer(env, "CHAIN_FETCH_TIMEOUT_MS", 5_000, 500, 60_000),
    chainMaxRetries: integer(env, "CHAIN_MAX_RETRIES", 3, 0, 10),
    worldSocketMaxPayloadBytes: integer(env, "WORLD_WS_MAX_PAYLOAD_BYTES", 16_384, 1_024, 1_048_576),
    worldHeartbeatMs: integer(env, "WORLD_HEARTBEAT_MS", 30_000, 5_000, 120_000),
    worldHeartbeatTimeoutMs: integer(env, "WORLD_HEARTBEAT_TIMEOUT_MS", 75_000, 10_000, 600_000),
    worldMaxSocketsPerAccount: integer(env, "WORLD_MAX_SOCKETS_PER_ACCOUNT", 3, 1, 50),
    worldMaxSocketsPerIp: integer(env, "WORLD_MAX_SOCKETS_PER_IP", 20, 1, 500),
    worldMaxQueuedBytes: integer(env, "WORLD_MAX_QUEUED_BYTES", 1_048_576, 16_384, 16_777_216),
    worldReplayLimit: integer(env, "WORLD_REPLAY_LIMIT", 200, 1, 500),
    worldPresenceTimeoutMs: integer(env, "WORLD_PRESENCE_TIMEOUT_MS", 60_000, 10_000, 600_000),
    worldFanoutPollMs: integer(env, "WORLD_FANOUT_POLL_MS", 100, 100, 30_000),
    worldTickMs: integer(env, "WORLD_TICK_MS", 250, 100, 30_000),
    worldTilesPerTick: integer(env, "WORLD_TILES_PER_TICK", 1, 1, 8),
    worldMoveCooldownMs: integer(env, "WORLD_MOVE_COOLDOWN_MS", 250, 50, 10_000),
    worldMoveBurst: integer(env, "WORLD_MOVE_BURST", 4, 1, 32),
    worldInteractionCooldownMs: integer(env, "WORLD_INTERACTION_COOLDOWN_MS", 500, 50, 30_000),
    worldInteractionBurst: integer(env, "WORLD_INTERACTION_BURST", 2, 1, 16),
  };
  if (config.worldHeartbeatTimeoutMs <= config.worldHeartbeatMs) {
    throw new ConfigError("WORLD_HEARTBEAT_TIMEOUT_MS must exceed WORLD_HEARTBEAT_MS");
  }
  if (config.chainSourceRequired && !config.chainEventSourceUrl) {
    throw new ConfigError("CHAIN_EVENT_SOURCE_URL is required for this environment");
  }

  assertManagedWalletConfigurationIsSafe(config);
  assertDemoConfigurationIsSafe(config);

  return config;
}

export function redactedSummary(config: AppConfig): Record<string, unknown> {
  return {
    appEnv: config.appEnv,
    autoTestnetWallets: config.autoTestnetWallets,
    demoMode: config.demoMode,
    networkId: config.networkId,
    rpcHost: new URL(config.rpcUrl).host,
    contractId: config.contractId,
    operatorAccount: config.operatorAccount,
    databaseHost: new URL(config.databaseUrl).host,
    port: config.port,
    host: config.host,
    webOrigin: config.webOrigin,
    npcTickMs: config.npcTickMs,
    cityTimezone: config.cityTimezone,
    npcSimulationTickMs: config.npcSimulationTickMs,
    npcSimulationCatchupMs: config.npcSimulationCatchupMs,
    e2eApi: config.e2eApi,
    worldSocketMaxPayloadBytes: config.worldSocketMaxPayloadBytes,
    worldHeartbeatMs: config.worldHeartbeatMs,
    worldHeartbeatTimeoutMs: config.worldHeartbeatTimeoutMs,
    worldMaxSocketsPerAccount: config.worldMaxSocketsPerAccount,
    worldMaxSocketsPerIp: config.worldMaxSocketsPerIp,
    worldMaxQueuedBytes: config.worldMaxQueuedBytes,
    worldReplayLimit: config.worldReplayLimit,
    worldPresenceTimeoutMs: config.worldPresenceTimeoutMs,
    worldFanoutPollMs: config.worldFanoutPollMs,
    worldTickMs: config.worldTickMs,
    worldTilesPerTick: config.worldTilesPerTick,
    worldMoveCooldownMs: config.worldMoveCooldownMs,
    worldMoveBurst: config.worldMoveBurst,
    worldInteractionCooldownMs: config.worldInteractionCooldownMs,
    worldInteractionBurst: config.worldInteractionBurst,
  };
}

export function assertManagedWalletConfigurationIsSafe(
  config: Pick<
    AppConfig,
    | "autoTestnetWallets"
    | "networkId"
    | "appEnv"
    | "testnetWalletEncryptionKey"
    | "testnetWalletFaucetUrl"
    | "testnetWalletAccountSuffix"
    | "rpcUrl"
  >,
) {
  if (!config.autoTestnetWallets) return;
  if (config.networkId !== "testnet" || config.appEnv === "production")
    throw new ConfigError("AUTO_TESTNET_WALLETS is available only for non-production testnet");
  if (
    config.testnetWalletAccountSuffix !== "testnet" &&
    !(
      config.appEnv === "test" &&
      isLoopbackHost(new URL(config.rpcUrl).hostname) &&
      isValidAccountId(config.testnetWalletAccountSuffix) &&
      config.testnetWalletAccountSuffix.length <= 28
    )
  )
    throw new ConfigError("TESTNET_WALLET_ACCOUNT_SUFFIX may change only for a loopback test sandbox");
  const key = config.testnetWalletEncryptionKey;
  if (
    !key ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, "base64").length !== 32 ||
    Buffer.from(key, "base64").toString("base64") !== key
  )
    throw new ConfigError("TESTNET_WALLET_ENCRYPTION_KEY must be a canonical base64 32-byte key");
  const endpoint = new URL(config.testnetWalletFaucetUrl);
  if (
    endpoint.protocol !== "https:" &&
    !(config.appEnv === "test" && isLoopbackHost(endpoint.hostname) && endpoint.protocol === "http:")
  )
    throw new ConfigError("TESTNET_WALLET_FAUCET_URL requires HTTPS");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new ConfigError("TESTNET_WALLET_FAUCET_URL cannot contain credentials, query or fragment");
}
