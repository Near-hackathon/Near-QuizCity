import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import { config } from "./runtime-config.js";
import { contractId, networkId } from "./near.js";

let cached: Account | null = null;

type FunctionCallOutcome = Awaited<ReturnType<Account["functionCall"]>>;

export type PayoutSubmission =
  | { kind: "confirmed"; txHash: string; outcome: FunctionCallOutcome }
  | { kind: "rejected"; txHash?: string; code: string; safeMessage: string }
  | {
      kind: "unknown";
      txHash?: string;
      code: "CHAIN_TIMEOUT" | "CHAIN_UNAVAILABLE" | "UNKNOWN";
    };

export async function getOperator(): Promise<Account> {
  if (cached) return cached;
  const accountId = config.operatorAccount;
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    networkId,
    accountId,
    KeyPair.fromString(config.operatorPrivateKey as Parameters<typeof KeyPair.fromString>[0]),
  );
  const near = await connect({
    networkId,
    nodeUrl: config.rpcUrl,
    keyStore,
    deps: { keyStore },
  });
  cached = await near.account(accountId);
  return cached;
}

function transactionHashFromMessage(message: string): string | undefined {
  const match = /^Transaction ([1-9A-HJ-NP-Za-km-z]{43,44}) failed\./.exec(message);
  return match?.[1];
}

export function classifySubmissionError(error: unknown): PayoutSubmission {
  const record = error as { type?: unknown; message?: unknown } | null;
  const type = typeof record?.type === "string" ? record.type : "";
  const message = typeof record?.message === "string" ? record.message : "";
  const txHash = transactionHashFromMessage(message);

  // Transport failures remain unknown even when the provider message happens
  // to contain a transaction hash. A known hash lets reconciliation continue;
  // it does not prove that execution reached a final rejected state.
  if (type === "TimeoutError" || type === "TIMEOUT_ERROR") {
    return { kind: "unknown", txHash, code: "CHAIN_TIMEOUT" };
  }
  if (type === "NetworkError" || type === "NETWORK_ERROR" || type === "ECONNRESET") {
    return { kind: "unknown", txHash, code: "CHAIN_UNAVAILABLE" };
  }
  // The near-api-js account layer throws this exact shape only after the RPC
  // returned a final failed execution status. Everything else is unknown.
  if (txHash && type.length > 0) {
    return {
      kind: "rejected",
      txHash,
      code: type,
      safeMessage: "transaction failed on chain",
    };
  }
  return { kind: "unknown", txHash, code: "UNKNOWN" };
}

export type PayoutSubmitter = {
  accountId: string;
  functionCall: (input: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    gas: bigint;
    attachedDeposit: bigint;
  }) => Promise<FunctionCallOutcome>;
  txStatus: (txHash: string, accountId: string, waitUntil: "FINAL") => Promise<unknown>;
};

function outcomeHash(outcome: unknown): string | undefined {
  const id = (outcome as { transaction_outcome?: { id?: unknown } } | null)?.transaction_outcome?.id;
  return typeof id === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(id) ? id : undefined;
}

function finalityFailure(final: unknown): boolean {
  const status = (final as { status?: unknown } | null)?.status;
  return typeof status === "object" && status !== null && "Failure" in status;
}

/**
 * Submits one payout and separates the three failure stages: no known outcome,
 * known outcome with failed finality, and confirmed finality. A hash returned by
 * submission is preserved in every later result.
 */
export async function submitPayout(
  submitter: PayoutSubmitter,
  methodName: string,
  args: Record<string, unknown>,
): Promise<PayoutSubmission> {
  let outcome: FunctionCallOutcome;
  try {
    outcome = await submitter.functionCall({
      contractId,
      methodName,
      args,
      gas: 30_000_000_000_000n,
      attachedDeposit: 0n,
    });
  } catch (error) {
    return classifySubmissionError(error);
  }

  const txHash = outcomeHash(outcome);
  if (!txHash) {
    return { kind: "unknown", code: "UNKNOWN" };
  }

  let final: unknown;
  try {
    final = await submitter.txStatus(txHash, submitter.accountId, "FINAL");
  } catch (error) {
    const classified = classifySubmissionError(error);
    return {
      kind: "unknown",
      txHash,
      code: classified.kind === "unknown" ? classified.code : "UNKNOWN",
    };
  }
  if (finalityFailure(final)) {
    return {
      kind: "rejected",
      txHash,
      code: "FINAL_FAILURE",
      safeMessage: "transaction failed on chain",
    };
  }
  return { kind: "confirmed", txHash, outcome };
}

async function submit(methodName: string, args: Record<string, unknown>): Promise<PayoutSubmission> {
  const account = await getOperator();
  return submitPayout(
    {
      accountId: account.accountId,
      functionCall: (input) => account.functionCall(input),
      // Views at finality must observe the payout before the caller mirrors
      // balances. `functionCall` may return at optimistic execution.
      txStatus: (txHash, accountId, waitUntil) =>
        account.connection.provider.txStatus(txHash, accountId, waitUntil),
    },
    methodName,
    args,
  );
}

export async function creditReward(
  wallet: string,
  amount: string,
  reference: string,
): Promise<PayoutSubmission> {
  return submit("credit_reward", { wallet, amount, reference });
}

export async function payJob(
  employerWallet: string,
  employeeWallet: string,
  amount: string,
  reference: string,
): Promise<PayoutSubmission> {
  return submit("pay_job", {
    employer_wallet: employerWallet,
    employee_wallet: employeeWallet,
    amount,
    reference,
  });
}

/** Explicit city-economy methods; a restricted v2 payout key is required after deployment. */
export async function submitCityPayment(
  method: "settle_escrow" | "npc_purchase",
  args: Record<string, unknown>,
): Promise<PayoutSubmission> {
  return submit(method, args);
}
