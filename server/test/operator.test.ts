import assert from "node:assert/strict";
import test from "node:test";
import { testEnv } from "./fixtures.js";

Object.assign(process.env, testEnv);
const { classifySubmissionError, submitPayout } = await import("../src/operator.js");

const txHash = "A".repeat(44);

test("payout outcomes are classified by structured type, never by message text", () => {
  const rejected = classifySubmissionError({
    type: "FunctionCallError",
    message: `Transaction ${txHash} failed. Smart contract panicked`,
  });
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.txHash, txHash);
  assert.equal(rejected.safeMessage, "transaction failed on chain");

  assert.deepEqual(classifySubmissionError({ type: "TimeoutError", message: "timed out" }), {
    kind: "unknown",
    txHash: undefined,
    code: "CHAIN_TIMEOUT",
  });
  assert.deepEqual(classifySubmissionError({ type: "NetworkError", message: "connection reset" }), {
    kind: "unknown",
    txHash: undefined,
    code: "CHAIN_UNAVAILABLE",
  });
  assert.deepEqual(
    classifySubmissionError({
      type: "TimeoutError",
      message: `Transaction ${txHash} failed. Provider timed out while waiting for finality`,
    }),
    {
      kind: "unknown",
      txHash,
      code: "CHAIN_TIMEOUT",
    },
  );

  // Plain text that mentions a final rejection must stay unknown.
  const textOnly = classifySubmissionError(new Error("insufficient allowance: rejected"));
  assert.equal(textOnly.kind, "unknown");
  assert.equal(textOnly.code, "UNKNOWN");

  const untypedTransaction = classifySubmissionError({
    message: `Transaction ${txHash} failed.`,
  });
  assert.equal(untypedTransaction.kind, "unknown");
  assert.equal(untypedTransaction.code, "UNKNOWN");
});

const submitted = { transaction_outcome: { id: txHash } } as never;

function submitter(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "operator.testnet",
    functionCall: async () => submitted,
    txStatus: async () => ({ status: { SuccessValue: "" } }),
    ...overrides,
  };
}

test("submission and finality success return the exact hash and call each stage once", async () => {
  let calls = 0;
  let finality = 0;
  const result = await submitPayout(
    submitter({
      functionCall: async () => {
        calls += 1;
        return submitted;
      },
      txStatus: async (hash: string, account: string, waitUntil: string) => {
        finality += 1;
        assert.equal(hash, txHash);
        assert.equal(account, "operator.testnet");
        assert.equal(waitUntil, "FINAL");
        return { status: { SuccessValue: "" } };
      },
    }),
    "pay_job",
    {},
  );
  assert.equal(result.kind, "confirmed");
  assert.equal(result.txHash, txHash);
  assert.equal(calls, 1);
  assert.equal(finality, 1);
});

test("finality failures preserve the submitted hash and never resubmit", async () => {
  for (const [error, code] of [
    [{ type: "TimeoutError", message: "finality timeout" }, "CHAIN_TIMEOUT"],
    [{ type: "NetworkError", message: "connection reset" }, "CHAIN_UNAVAILABLE"],
    [new Error("unexpected finality failure"), "UNKNOWN"],
  ] as const) {
    let calls = 0;
    const result = await submitPayout(
      submitter({
        functionCall: async () => {
          calls += 1;
          return submitted;
        },
        txStatus: async () => {
          throw error;
        },
      }),
      "credit_reward",
      {},
    );
    assert.equal(result.kind, "unknown");
    assert.equal(result.txHash, txHash);
    assert.equal(result.code, code);
    assert.equal(calls, 1);
  }
});

test("a structured final failure with a status is a typed rejection", async () => {
  const result = await submitPayout(
    submitter({ txStatus: async () => ({ status: { Failure: { error_message: "panicked" } } }) }),
    "pay_job",
    {},
  );
  assert.equal(result.kind, "rejected");
  assert.equal(result.txHash, txHash);
  assert.equal(result.code, "FINAL_FAILURE");
});

test("submission failures before an outcome are classified without inventing a hash", async () => {
  const timeout = await submitPayout(
    submitter({
      functionCall: async () => {
        throw { type: "TimeoutError", message: "broadcast timeout" };
      },
    }),
    "pay_job",
    {},
  );
  assert.equal(timeout.kind, "unknown");
  assert.equal(timeout.code, "CHAIN_TIMEOUT");
  assert.equal(timeout.txHash, undefined);

  const network = await submitPayout(
    submitter({
      functionCall: async () => {
        throw { type: "ECONNRESET", message: "reset" };
      },
    }),
    "pay_job",
    {},
  );
  assert.equal(network.kind, "unknown");
  assert.equal(network.code, "CHAIN_UNAVAILABLE");

  const textOnly = await submitPayout(
    submitter({
      functionCall: async () => {
        throw new Error("rejected: insufficient allowance");
      },
    }),
    "pay_job",
    {},
  );
  assert.equal(textOnly.kind, "unknown");
  assert.equal(textOnly.code, "UNKNOWN");
});

test("a malformed submission outcome is unknown without a fabricated hash", async () => {
  const result = await submitPayout(submitter({ functionCall: async () => ({}) as never }), "pay_job", {});
  assert.equal(result.kind, "unknown");
  assert.equal(result.code, "UNKNOWN");
  assert.equal(result.txHash, undefined);
});
