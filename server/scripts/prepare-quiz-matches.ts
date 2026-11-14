/** Administrator-only bootstrap: two empty logical QC wallets, no issuance or player spending. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, KeyPair, keyStores, providers } from "near-api-js";
import { config } from "../src/runtime-config.js";
import { assertTestnetUpgradeTarget, digest, CITY_PAYOUT_METHODS } from "../src/testnet-upgrade.js";
import { assertRestrictedPayoutKey } from "../src/access-key.js";
import { MATCH_VENUE_WALLET, MATCH_GAS_WALLET } from "../src/quiz-match-policy.js";
import { viewAllWallets } from "../src/near.js";
import { verifyExpectedFunctionCall } from "../src/verify.js";
import { recordVerifiedEventsIn } from "../src/record-chain-events.js";
import { readChainBalance, setMirroredBalance } from "../src/sync.js";
import { sql, closeDb } from "../src/db.js";
assertTestnetUpgradeTarget(config);
const apply = process.argv[2] === "--apply";
if (process.argv.length > 3 || (process.argv[2] && !apply && process.argv[2] !== "--dry-run"))
  throw Error("Use --dry-run or --apply.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = resolve(
  homedir(),
  ".config",
  "quiz-city",
  digest(root).slice(0, 16),
  "deployment",
  config.contractId,
);
async function main() {
  const wallets = await viewAllWallets();
  const missing = [MATCH_VENUE_WALLET, MATCH_GAS_WALLET].filter(
    (id) => !wallets.some((w) => w.wallet_id === id),
  );
  if (!apply) {
    console.log(
      JSON.stringify({
        dryRun: true,
        contract: config.contractId,
        createEmptyWallets: missing,
        initialQc: "0",
      }),
    );
    return;
  }
  const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
  const payoutPublic = KeyPair.fromString(config.operatorPrivateKey as never)
    .getPublicKey()
    .toString();
  const access: any = await provider.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: config.operatorAccount,
    public_key: payoutPublic,
  });
  assertRestrictedPayoutKey(access.permission, {
    receiverId: config.contractId,
    methods: CITY_PAYOUT_METHODS,
  });
  const recovery = JSON.parse(await readFile(resolve(directory, "recovery-key.json"), "utf8"));
  const key = KeyPair.fromString(recovery.private_key);
  if (key.getPublicKey().toString() !== recovery.public_key)
    throw Error("Recovery credential identity mismatch.");
  const permission: any = await provider.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: config.operatorAccount,
    public_key: recovery.public_key,
  });
  if (permission.permission !== "FullAccess")
    throw Error("The offline administrator credential is not valid.");
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey("testnet", config.operatorAccount, key);
  const account = await (
    await connect({ networkId: "testnet", nodeUrl: config.rpcUrl, keyStore: store })
  ).account(config.operatorAccount);
  const path = resolve(directory, "quiz-match-treasuries.json");
  let journal: Record<string, any> = {};
  try {
    journal = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  async function persist() {
    await writeFile(path + ".tmp", JSON.stringify(journal, null, 2), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  for (const wallet of [MATCH_VENUE_WALLET, MATCH_GAS_WALLET]) {
    let step = journal[wallet];
    if (!step && !missing.includes(wallet)) {
      console.log(JSON.stringify({ wallet, alreadyPresent: true }));
      continue;
    }
    if (!step) {
      step = journal[wallet] = { state: "prepared" };
      await persist();
    }
    if (step.state === "prepared") {
      step.state = "submitting";
      await persist();
      const result = await account.functionCall({
        contractId: config.contractId,
        methodName: "create_wallet",
        args: { wallet, initial_balance: "0" },
        gas: 30000000000000n,
        attachedDeposit: 0n,
      });
      step.hash = result.transaction.hash;
      step.state = "submitted";
      await persist();
    }
    if (!step.hash)
      throw Error(
        "Wallet creation has an unknown result. Reconcile the administrator journal before retrying.",
      );
    const proof = await verifyExpectedFunctionCall(step.hash, {
      signerId: config.operatorAccount,
      method: "create_wallet",
      args: { wallet, initial_balance: "0" },
      events: [
        {
          name: "wallet_created",
          entityId: wallet,
          walletFrom: null,
          walletTo: null,
          amount: "0",
          reference: `wallet:${wallet}`,
        },
      ],
    });
    const balance = await readChainBalance(wallet);
    await sql.begin(async (tx) => {
      await recordVerifiedEventsIn(tx, proof.events);
      await setMirroredBalance(tx, wallet, balance);
    });
    step.state = "verified";
    await persist();
    console.log(JSON.stringify({ wallet, initialQc: "0", txHash: step.hash, verified: true }));
  }
}
try {
  await main();
} catch {
  console.error(
    "Quiz treasury preparation stopped. Review the protected administrator journal; no private credentials were printed.",
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
