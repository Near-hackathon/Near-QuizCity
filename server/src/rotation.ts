import type { AppConfig } from "./config.js";

export const ROTATION_CONFIRM_FLAG = "--confirm-demo-key-rotation";

export type RotationEnvironment = Pick<
  AppConfig,
  "appEnv" | "networkId" | "demoMode" | "contractId" | "operatorAccount"
>;

export type RotationTarget = { accountId: string; publicKey: string; secretKey: string };

export function isTestnetAccount(accountId: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(accountId) || accountId.endsWith(".testnet") || accountId.endsWith(".test.near")
  );
}

export function rotationEnvironmentErrors(env: RotationEnvironment): string[] {
  const errors: string[] = [];
  if (env.appEnv !== "local" && env.appEnv !== "test") {
    errors.push("APP_ENV must be local or test");
  }
  if (env.networkId !== "testnet") {
    errors.push("NEAR_NETWORK must be testnet");
  }
  if (!env.demoMode) {
    errors.push("DEMO_MODE must be 1");
  }
  if (!isTestnetAccount(env.contractId)) {
    errors.push("NEAR_CONTRACT_ID must be a testnet account");
  }
  if (!isTestnetAccount(env.operatorAccount)) {
    errors.push("NEAR_OPERATOR_ACCOUNT must be a testnet account");
  }
  return errors;
}

export function assertRotationEnvironment(env: RotationEnvironment): void {
  const errors = rotationEnvironmentErrors(env);
  if (errors.length > 0) {
    throw new Error(`key rotation refused: ${errors.join("; ")}`);
  }
}

export type RotationRuntimeConfig = RotationEnvironment & { rpcUrl: string };

/**
 * Reads only the fields demo-key rotation needs. It deliberately never touches
 * NEAR_OPERATOR_PRIVATE_KEY or any other secret.
 */
export function rotationConfigFromEnv(env: NodeJS.ProcessEnv): RotationRuntimeConfig {
  return {
    appEnv: (env.APP_ENV ?? "") as RotationEnvironment["appEnv"],
    networkId: (env.NEAR_NETWORK ?? "") as RotationEnvironment["networkId"],
    demoMode: env.DEMO_MODE === "1",
    contractId: env.NEAR_CONTRACT_ID ?? "",
    operatorAccount: env.NEAR_OPERATOR_ACCOUNT ?? "",
    rpcUrl: env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com",
  };
}

export function parseRotationArgs(argv: string[]): { confirm: boolean; help: boolean } {
  const unknown = argv.filter((arg) => arg !== ROTATION_CONFIRM_FLAG && arg !== "--help");
  if (unknown.length > 0) {
    throw new Error(`unknown arguments: ${unknown.join(", ")}`);
  }
  return { confirm: argv.includes(ROTATION_CONFIRM_FLAG), help: argv.includes("--help") };
}

export function rotationTargets<T extends { accountId: string }>(
  entries: T[],
  operatorAccount: string,
  contractId: string,
): T[] {
  return entries.filter((entry) => entry.accountId !== operatorAccount && entry.accountId !== contractId);
}

export type DemoRotationPlan<T extends { accountId: string }> = {
  scope: "demo-player-keys";
  accounts: T[];
  backupFiles: ["demo-accounts.json"];
  mutatesOperator: false;
};

/**
 * Demo-account rotation is deliberately player-only. The operator payout key is
 * a restricted function-call key and cannot add its own replacement, so operator
 * rotation is an administrator-only operation with the offline deploy key.
 */
export function planDemoRotation<T extends { accountId: string }>(
  entries: T[],
  operatorAccount: string,
  contractId: string,
): DemoRotationPlan<T> {
  return {
    scope: "demo-player-keys",
    accounts: rotationTargets(entries, operatorAccount, contractId),
    backupFiles: ["demo-accounts.json"],
    mutatesOperator: false,
  };
}
