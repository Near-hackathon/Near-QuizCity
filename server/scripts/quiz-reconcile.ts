import { config } from "../src/runtime-config.js";
import { sql } from "../src/db.js";
import { insertLedgerEntries } from "../src/ledger.js";
import { viewContract } from "../src/near.js";
import { readChainBalance, setMirroredBalance } from "../src/sync.js";
import { verifyExpectedFunctionCall } from "../src/verify.js";
import { reconcileDueQuizRewards, type QuizRewardDeps } from "../src/quiz-reconciler.js";

const deps: QuizRewardDeps = {
  db: sql,
  operatorAccount: config.operatorAccount,
  verifyExpectedFunctionCall: (txHash, expectation) => verifyExpectedFunctionCall(txHash, expectation),
  readChainBalance,
  setMirroredBalance,
  insertLedgerEntries,
  viewContract,
  now: () => new Date(),
};

const once = process.argv.includes("--once");
if (once) {
  console.log(JSON.stringify(await reconcileDueQuizRewards(deps), null, 2));
  await sql.end();
} else {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileDueQuizRewards(deps);
      if (result.claimed > 0) console.log(JSON.stringify(result));
    } catch (error) {
      console.error("quiz reconciliation tick failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  void tick();
  const stop = async () => {
    clearInterval(timer);
    await sql.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
