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
import {
  assertRotationEnvironment,
  parseRotationArgs,
  planDemoRotation,
  rotationConfigFromEnv,
  type RotationTarget,
} from "../src/rotation.js";

const demoPath = new URL("../demo-accounts.json", import.meta.url);
const backupRoot = new URL("../backups/", import.meta.url);

type DemoFile = Record<string, RotationTarget>;

const { confirm, help } = parseRotationArgs(process.argv.slice(2));
if (help) {
  console.log(`Usage: node --env-file=.env --import tsx scripts/rotate-demo-keys.ts [--confirm-demo-key-rotation]

Rotates only disposable demo player keys in demo-accounts.json.
It never reads, writes, adds, or deletes the operator payout key or server/.env.

Without the confirmation flag this is a dry run: it prints demo player account IDs
and public keys only. Rotation is allowed only for APP_ENV=local|test,
NEAR_NETWORK=testnet, DEMO_MODE=1.`);
  process.exit(0);
}

const rotation = rotationConfigFromEnv(process.env);
assertRotationEnvironment(rotation);

const parsed = JSON.parse(readFileSync(demoPath, "utf8")) as DemoFile;
const plan = planDemoRotation(Object.values(parsed), rotation.operatorAccount, rotation.contractId);
const provider = new providers.JsonRpcProvider({ url: rotation.rpcUrl });

async function connectAccount(accountId: string, key: KeyPairType): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(rotation.networkId, accountId, key);
  const near = await connect({
    networkId: rotation.networkId,
    nodeUrl: rotation.rpcUrl,
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

console.log(`demo player key rotation mode: ${confirm ? "CONFIRMED" : "dry run"}`);
console.log(
  `network: ${rotation.networkId} | contract: ${rotation.contractId} | operator (excluded): ${rotation.operatorAccount}`,
);

for (const entry of plan.accounts) {
  const keys = await currentPublicKeys(entry.accountId);
  console.log(`- ${entry.accountId}: ${keys.length} key(s) [${keys.join(", ")}] -> would add a new key`);
}

if (!confirm) {
  console.log("\nNo changes made. Re-run with --confirm-demo-key-rotation to rotate these demo player keys.");
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(fileURLToPath(backupRoot), timestamp);
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
backup(demoPath, join(backupDir, "demo-accounts.json"));
console.log(`demo-accounts backup written to ${backupDir}`);

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
  for (const entry of plan.accounts) {
    const oldPublicKey = entry.publicKey;
    const newPublicKey = await rotate(entry, async (next) => {
      entry.secretKey = next.toString();
      entry.publicKey = next.getPublicKey().toString();
      writeAtomic(demoPath, `${JSON.stringify(parsed, null, 2)}\n`);
    });
    touched.push({ accountId: entry.accountId, oldPublicKey, newPublicKey });
    console.log(`rotated demo player ${entry.accountId} -> ${newPublicKey}`);
  }

  const removed = Object.entries(parsed).filter(
    ([, entry]) => entry.accountId === rotation.operatorAccount || entry.accountId === rotation.contractId,
  );
  for (const [name] of removed) delete parsed[name];
  if (removed.length > 0) {
    writeAtomic(demoPath, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log("removed operator/contract credentials from demo-accounts.json");
  }

  console.log(`\nDone. Restart the server if it caches demo keys. Backup: ${backupDir}`);
} catch (error) {
  console.error(
    `\ndemo player key rotation stopped: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(
    "No further demo accounts were touched. The operator payout key and server/.env were not modified.",
  );
  console.error(`- demo-accounts backup: ${join(backupDir, "demo-accounts.json")}`);
  for (const item of touched) {
    console.error(`- ${item.accountId}: old ${item.oldPublicKey}, new ${item.newPublicKey}`);
  }
  console.error("- Restore demo-accounts.json from the backup if the new demo key was not persisted.");
  console.error("- Never print or commit private keys.");
  process.exit(1);
}
