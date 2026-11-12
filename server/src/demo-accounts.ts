import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertDemoConfigurationIsSafe, type AppConfig } from "./config.js";

export type DemoEntry = { accountId: string; publicKey: string; secretKey: string };
export type DemoPayload = { networkId: string; contractId: string; accounts: DemoEntry[] };

const cache = new Map<string, DemoPayload>();

function sourcePath(cfg: AppConfig): string | URL {
  return cfg.demoAccountsFile
    ? resolve(cfg.demoAccountsFile)
    : new URL("../demo-accounts.json", import.meta.url);
}

export function loadDemoAccounts(cfg: AppConfig): DemoPayload {
  assertDemoConfigurationIsSafe(cfg);

  const source = sourcePath(cfg);
  const cacheKey = String(source);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const parsed = JSON.parse(readFileSync(source, "utf8")) as Record<string, DemoEntry>;
  const reserved = (entry: DemoEntry) =>
    entry.accountId === cfg.operatorAccount ||
    entry.accountId === cfg.contractId ||
    entry.secretKey === cfg.operatorPrivateKey;

  const entries = Object.values(parsed);
  const accounts = entries.filter((entry) => !reserved(entry));
  if (accounts.length !== entries.length) {
    console.warn("[demo] excluded operator/contract credentials from the demo account list");
  }

  const payload: DemoPayload = { networkId: cfg.networkId, contractId: cfg.contractId, accounts };
  cache.set(cacheKey, payload);
  return payload;
}
