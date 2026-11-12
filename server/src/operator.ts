import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import { config } from "./runtime-config.js";
import { contractId, networkId } from "./near.js";

let cached: Account | null = null;

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

export async function creditReward(wallet: string, amount: number, reference: string): Promise<string> {
  const account = await getOperator();
  const outcome = await account.functionCall({
    contractId,
    methodName: "credit_reward",
    args: { wallet, amount: String(amount), reference },
    gas: 30_000_000_000_000n,
    attachedDeposit: 0n,
  });
  return outcome.transaction_outcome.id;
}

export async function payJob(
  employerWallet: string,
  employeeWallet: string,
  amount: number,
  reference: string,
): Promise<string> {
  const account = await getOperator();
  const outcome = await account.functionCall({
    contractId,
    methodName: "pay_job",
    args: {
      employer_wallet: employerWallet,
      employee_wallet: employeeWallet,
      amount: String(amount),
      reference,
    },
    gas: 30_000_000_000_000n,
    attachedDeposit: 0n,
  });
  return outcome.transaction_outcome.id;
}
