import type { AppConfig } from "./config.js";

export const ROTATION_CONFIRM_FLAG = "--confirm-testnet-rotation";

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
