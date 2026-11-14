import { api } from "../api";
import { demoSigner, demoTransaction, registerDemoKey } from "../wallet/demo-loader";
import type { SendTransactionInput } from "../wallet/types";

/** Reloaded local demo sessions must restore their disposable, memory-only signer. */
export async function sendDemoWalletTransaction(
  demoMode: boolean,
  accountId: string,
  input: SendTransactionInput,
) {
  if (!demoMode || !import.meta.env.DEV) throw new Error("Demo wallet is unavailable.");
  if (!(await demoSigner(demoMode, accountId))) {
    const { accounts, networkId, contractId } = await api.demoAccounts();
    if (networkId !== "testnet" || contractId !== input.receiverId)
      throw new Error("The demo wallet configuration has changed. Sign in again.");
    const account = accounts.find((entry) => entry.accountId === accountId);
    if (!account) throw new Error("Sign out and choose an available demo account.");
    await registerDemoKey(demoMode, accountId, account.publicKey, account.secretKey);
  }
  const result = await demoTransaction(demoMode, accountId, input);
  if (!result) throw new Error("Demo wallet could not be restored. Sign out and sign in again.");
  return result;
}
