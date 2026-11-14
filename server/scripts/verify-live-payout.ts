import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../src/runtime-config.js";
import { assertTestnetUpgradeTarget, CITY_PAYOUT_METHODS } from "../src/testnet-upgrade.js";
import { assertRestrictedPayoutKey } from "../src/access-key.js";
import { KeyPair, providers } from "near-api-js";
import { payJob } from "../src/operator.js";
import { verifyExpectedFunctionCall } from "../src/verify.js";
import { viewContract } from "../src/near.js";
import { recordVerifiedEventsIn } from "../src/record-chain-events.js";
import { setMirroredBalance, syncEconomy } from "../src/sync.js";
import { sql, closeDb } from "../src/db.js";
assertTestnetUpgradeTarget(config);
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw Error("Supply the prepared administrator directory.");
const path = resolve(directory, "payout-check.json");
let journal: any;
async function persist() {
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function main() {
  const pub = KeyPair.fromString(config.operatorPrivateKey as never)
    .getPublicKey()
    .toString();
  const rpc = new providers.JsonRpcProvider({ url: config.rpcUrl });
  const access = (await rpc.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: config.operatorAccount,
    public_key: pub,
  })) as any;
  assertRestrictedPayoutKey(access.permission, {
    receiverId: config.contractId,
    methods: CITY_PAYOUT_METHODS,
  });
  const deployment = JSON.parse(await readFile(resolve(directory, "deployment.json"), "utf8"));
  try {
    journal = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    journal = {
      publicKey: pub,
      initialNpc: await viewContract("get_balance", { wallet: "npc:professor-kofi" }),
      initialCouncil: await viewContract("get_balance", { wallet: "gov:council" }),
      initialStats: await viewContract("get_stats"),
      steps: [
        {
          from: "npc:professor-kofi",
          to: "gov:council",
          reference: `deployment:${deployment.wasmSha256.slice(0, 12)}:out`,
          state: "prepared",
        },
        {
          from: "gov:council",
          to: "npc:professor-kofi",
          reference: `deployment:${deployment.wasmSha256.slice(0, 12)}:return`,
          state: "prepared",
        },
      ],
    };
    await persist();
  }
  for (const step of journal.steps) {
    if (step.state === "verified") continue;
    if (step.state === "prepared") {
      // A process interruption after this write is unknown, never a blind retry.
      step.state = "submitting";
      await persist();
      const sent = await payJob(step.from, step.to, "1", step.reference);
      if (sent.kind !== "confirmed") {
        step.state = sent.kind;
        step.txHash = sent.txHash;
        await persist();
        throw Error("Payout outcome needs reconciliation.");
      }
      step.txHash = sent.txHash;
      step.state = "confirmed";
      await persist();
    }
    if (!step.txHash) throw Error("Payout receipt is unknown. Manual reconciliation is required.");
    const proof = await verifyExpectedFunctionCall(step.txHash, {
      signerId: config.operatorAccount,
      method: "pay_job",
      args: { employer_wallet: step.from, employee_wallet: step.to, amount: "1", reference: step.reference },
      events: [
        {
          name: "job_reward",
          entityId: step.to,
          walletFrom: step.from,
          walletTo: step.to,
          amount: "1",
          reference: step.reference,
        },
      ],
    });
    if (!(await viewContract("is_reference_processed", { reference: step.reference })))
      throw Error("Payout reference was not confirmed.");
    const from = await viewContract<string>("get_balance", { wallet: step.from }),
      to = await viewContract<string>("get_balance", { wallet: step.to });
    await sql.begin(async (tx) => {
      await recordVerifiedEventsIn(tx, proof.events);
      await setMirroredBalance(tx, step.from, from);
      await setMirroredBalance(tx, step.to, to);
    });
    step.state = "verified";
    await persist();
  }
  const npc = await viewContract("get_balance", { wallet: "npc:professor-kofi" }),
    council = await viewContract("get_balance", { wallet: "gov:council" }),
    stats = await viewContract<any>("get_stats");
  if (
    npc !== journal.initialNpc ||
    council !== journal.initialCouncil ||
    stats.total_issued !== journal.initialStats.total_issued ||
    stats.total_burned !== journal.initialStats.total_burned
  )
    throw Error("Round-trip balances or supply do not match.");
  const sync = await syncEconomy();
  if (sync.skipped || sync.difference !== "0") throw Error("The mirror did not reconcile.");
  journal.passed = true;
  journal.supplyDifference = sync.difference;
  await persist();
  console.log(
    JSON.stringify({
      passed: true,
      publicKey: pub,
      permission: "FunctionCall",
      transactions: journal.steps.map((s: any) => ({
        hash: s.txHash,
        reference: s.reference,
        state: s.state,
      })),
      originalBalancesRestored: true,
      supplyDifference: sync.difference,
    }),
  );
}
main()
  .catch(() => {
    console.error(
      "Payout verification stopped. Check the protected journal; do not resubmit an unknown payment.",
    );
    process.exitCode = 1;
  })
  .finally(() => closeDb());
