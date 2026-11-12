import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connect,
  keyStores,
  KeyPair,
  providers,
  type Account,
  type KeyPair as KeyPairType,
} from "near-api-js";
import { config } from "../src/runtime-config.js";
import {
  assertRotationEnvironment,
  parseRotationArgs,
  rotationTargets,
  type RotationTarget,
} from "../src/rotation.js";

const demoPath = new URL("../demo-accounts.json", import.meta.url);
const envPath = new URL("../.env", import.meta.url);
const backupRoot = new URL("../backups/", import.meta.url);

type DemoFile = Record<string, RotationTarget>;

const { confirm, help } = parseRotationArgs(process.argv.slice(2));
if (help) {
  console.log(`Usage: node --env-file=.env --import tsx scripts/rotate-demo-keys.ts [--confirm-testnet-rotation]

Without the confirmation flag this is a dry run: it prints account IDs and public keys only.
Rotation is allowed only for APP_ENV=local|test, NEAR_NETWORK=testnet, DEMO_MODE=1.`);
  process.exit(0);
}

assertRotationEnvironment(config);

const parsed = JSON.parse(readFileSync(demoPath, "utf8")) as DemoFile;
const targets = rotationTargets(Object.values(parsed), config.operatorAccount, config.contractId);
const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });

async function connectAccount(accountId: string, key: KeyPairType): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(config.networkId, accountId, key);
  const near = await connect({
    networkId: config.networkId,
    nodeUrl: config.rpcUrl,
    keyStore,
    deps: { keyStore },
  });
  return near.account(accountId);
}

async function confirmKey(accountId: string, publicKey: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await provider.query({
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw new Error(`new key was not accepted for ${accountId}: ${String(lastError)}`);
}

async function currentPublicKeys(accountId: string): Promise<string[]> {
  const result = (await provider.query({
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  })) as unknown as { keys?: { public_key: string }[] };
  return (result.keys ?? []).map((entry) => entry.public_key);
}

function writeAtomic(path: URL, contents: string): void {
  const file = fileURLToPath(path);
  writeFileSync(`${file}.tmp`, contents, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function backup(path: URL, destination: string): void {
  writeFileSync(destination, readFileSync(fileURLToPath(path)), { mode: 0o600 });
}

console.log(`rotation mode: ${confirm ? "CONFIRMED" : "dry run"}`);
console.log(
  `network: ${config.networkId} | contract: ${config.contractId} | operator: ${config.operatorAccount}`,
);

for (const entry of targets) {
  const keys = await currentPublicKeys(entry.accountId);
  console.log(`- ${entry.accountId}: ${keys.length} key(s) [${keys.join(", ")}] -> would add a new key`);
}

if (!confirm) {
  console.log("\nNo changes made. Re-run with --confirm-testnet-rotation to rotate these accounts.");
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(fileURLToPath(backupRoot), timestamp);
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
backup(envPath, join(backupDir, ".env"));
backup(demoPath, join(backupDir, "demo-accounts.json"));
console.log(`backups written to ${backupDir}`);

const touched: { accountId: string; oldPublicKey: string; newPublicKey: string }[] = [];

async function rotate(
  target: RotationTarget,
  persist: (next: KeyPairType) => Promise<void>,
): Promise<string> {
  const oldKey = KeyPair.fromString(target.secretKey as Parameters<typeof KeyPair.fromString>[0]);
  const nextKey = KeyPair.fromRandom("ed25519");
  const oldAccount = await connectAccount(target.accountId, oldKey);

  await oldAccount.addKey(nextKey.getPublicKey().toString());
  await confirmKey(target.accountId, nextKey.getPublicKey().toString());
  await persist(nextKey);

  const nextAccount = await connectAccount(target.accountId, nextKey);
  await nextAccount.deleteKey(oldKey.getPublicKey());
  return nextKey.getPublicKey().toString();
}

try {
  for (const entry of targets) {
    const oldPublicKey = entry.publicKey;
    const newPublicKey = await rotate(entry, async (next) => {
      entry.secretKey = next.toString();
      entry.publicKey = next.getPublicKey().toString();
      writeAtomic(demoPath, `${JSON.stringify(parsed, null, 2)}\n`);
    });
    touched.push({ accountId: entry.accountId, oldPublicKey, newPublicKey });
    console.log(`rotated ${entry.accountId} -> ${newPublicKey}`);
  }

  const removed = Object.entries(parsed).filter(
    ([, entry]) => entry.accountId === config.operatorAccount || entry.accountId === config.contractId,
  );
  for (const [name] of removed) delete parsed[name];
  if (removed.length > 0) {
    writeAtomic(demoPath, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log("removed operator/contract credentials from demo-accounts.json");
  }

  const envText = readFileSync(envPath, "utf8");
  const operatorEntry: RotationTarget = {
    accountId: config.operatorAccount,
    publicKey: (await currentPublicKeys(config.operatorAccount))[0] ?? "",
    secretKey: config.operatorPrivateKey,
  };
  const operatorPublicKey = await rotate(operatorEntry, async (next) => {
    if (!/^NEAR_OPERATOR_PRIVATE_KEY=.*$/m.test(envText)) {
      throw new Error("NEAR_OPERATOR_PRIVATE_KEY line not found in .env");
    }
    const updated = envText.replace(/^NEAR_OPERATOR_PRIVATE_KEY=.*$/m, `NEAR_OPERATOR_PRIVATE_KEY=${next}`);
    writeAtomic(envPath, updated);
  });
  touched.push({
    accountId: config.operatorAccount,
    oldPublicKey: operatorEntry.publicKey,
    newPublicKey: operatorPublicKey,
  });
  console.log(`rotated operator ${config.operatorAccount} -> ${operatorPublicKey}`);
  console.log(`\nDone. Restart the server. Backups: ${backupDir}`);
} catch (error) {
  console.error(`\nrotation stopped: ${error instanceof Error ? error.message : String(error)}`);
  console.error("No further accounts were touched. Recovery:");
  console.error(`- backups: ${backupDir}`);
  for (const item of touched) {
    console.error(`- ${item.accountId}: old ${item.oldPublicKey}, new ${item.newPublicKey}`);
  }
  console.error("- Restore .env and demo-accounts.json from the backup if the new key was not persisted.");
  console.error("- Never print or commit private keys.");
  process.exit(1);
}
