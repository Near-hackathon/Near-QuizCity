import { buildApp } from "./app.js";
import { redactedSummary } from "./config.js";
import { closeDb, sql } from "./db.js";
import { config } from "./runtime-config.js";
import { createShutdown } from "./lifecycle.js";
import { startNpcWorker } from "./npc.js";
import { createHttpChainEventSource } from "./chain-source.js";
import { startChainIngester } from "./chain-ingester.js";
import { startJobReconciler, type JobPaymentDeps } from "./job-payment.js";
import { startQuizReconciler, type QuizRewardDeps } from "./quiz-reconciler.js";
import { insertLedgerEntries } from "./ledger.js";
import { viewContract } from "./near.js";
import { readChainBalance, setMirroredBalance } from "./sync.js";
import { verifyExpectedFunctionCall } from "./verify.js";
import { syncEconomy } from "./sync.js";

const app = await buildApp(config);
const stops: Array<() => void | Promise<void>> = [];

try {
  app.log.info({ config: redactedSummary(config) }, "configuration loaded");
  await app.listen({ port: config.port, host: config.host });

  const runSync = async () => {
    try {
      await syncEconomy();
    } catch (error) {
      app.log.warn({ err: error }, "chain sync failed");
    }
  };
  await runSync();
  const syncTimer = setInterval(runSync, 10_000);
  stops.push(() => clearInterval(syncTimer));

  const stopNpc = startNpcWorker({
    intervalMs: config.npcTickMs,
    onError: (error) => app.log.warn({ err: error }, "npc tick failed"),
  });
  stops.push(() => stopNpc.stop());

  const chainRuntime = { networkId: config.networkId, contractId: config.contractId };
  if (config.chainEventSourceUrl) {
    const source = createHttpChainEventSource({
      url: config.chainEventSourceUrl,
      networkId: config.networkId,
      contractId: config.contractId,
      timeoutMs: config.chainFetchTimeoutMs,
      maxRetries: config.chainMaxRetries,
    });
    const chainWorker = startChainIngester({
      db: sql,
      source,
      runtime: chainRuntime,
      intervalMs: config.chainPollIntervalMs,
      pageSize: config.chainPageSize,
      startBlock: config.chainStartBlock ?? undefined,
      onError: (error) => app.log.warn({ err: error }, "chain ingestion tick failed"),
    });
    stops.push(() => chainWorker.stop());
  }

  const payoutDeps = {
    operatorAccount: config.operatorAccount,
    readChainBalance,
    setMirroredBalance,
    insertLedgerEntries,
    viewContract,
    now: () => new Date(),
  };
  const jobWorker = startJobReconciler(
    {
      db: sql,
      ...payoutDeps,
      verifyExpectedFunctionCall: (txHash, expectation) => verifyExpectedFunctionCall(txHash, expectation),
    } satisfies JobPaymentDeps,
    { intervalMs: 60_000, onError: (error) => app.log.warn({ err: error }, "job reconciliation failed") },
  );
  stops.push(() => jobWorker.stop());
  const quizWorker = startQuizReconciler(
    {
      db: sql,
      ...payoutDeps,
      verifyExpectedFunctionCall: (txHash, expectation) => verifyExpectedFunctionCall(txHash, expectation),
    } satisfies QuizRewardDeps,
    { intervalMs: 60_000, onError: (error) => app.log.warn({ err: error }, "quiz reconciliation failed") },
  );
  stops.push(() => quizWorker.stop());
} catch (error) {
  app.log.error(error);
  await closeDb();
  process.exit(1);
}

const shutdown = createShutdown({
  timeoutMs: config.shutdownTimeoutMs,
  app,
  stop: stops,
  closeDb,
  onError: (error) => app.log.error({ err: error }, "shutdown error"),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}
