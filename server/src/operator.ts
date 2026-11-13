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

function classifySubmissionError(error: unknown): PayoutSubmission {
  const record = error as { type?: unknown; message?: unknown } | null;
  const type = typeof record?.type === "string" ? record.type : "";
  const message = typeof record?.message === "string" ? record.message : "";
  const txHash = transactionHashFromMessage(message);

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
  if (type === "TimeoutError" || type === "TIMEOUT_ERROR") {
    return { kind: "unknown", txHash, code: "CHAIN_TIMEOUT" };
  }
  if (type === "NetworkError" || type === "NETWORK_ERROR" || type === "ECONNRESET") {
    return { kind: "unknown", txHash, code: "CHAIN_UNAVAILABLE" };
  }
  return { kind: "unknown", txHash, code: "UNKNOWN" };
}

async function submit(methodName: string, args: Record<string, unknown>): Promise<PayoutSubmission> {
  const account = await getOperator();
  try {
    const outcome = await account.functionCall({
      contractId,
      methodName,
      args,
      gas: 30_000_000_000_000n,
      attachedDeposit: 0n,
    });
    return { kind: "confirmed", txHash: outcome.transaction_outcome.id, outcome };
  } catch (error) {
    return classifySubmissionError(error);
  }
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
