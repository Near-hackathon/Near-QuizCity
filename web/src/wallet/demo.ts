import type { Nep413Payload } from "../nep413";
import type { MessageSigner, SendTransactionInput } from "./types";

type DemoKey = {
  accountId: string;
  publicKey: string;
  signMessage(payload: Nep413Payload): Promise<{ accountId: string; publicKey: string; signature: string }>;
  signAndSendTransaction(input: SendTransactionInput): Promise<{ txHash: string }>;
};

const keys = new Map<string, DemoKey>();

/** Development-only: the secret stays in memory and never enters persistent storage. */
export async function registerDemoKey(
  accountId: string,
  publicKey: string,
  secretKey: string,
): Promise<void> {
  // The legacy NEAR transaction serializer references the global Buffer symbol.
  // Install it before loading the development-only SDK, including after reload.
  const { Buffer } = await import("buffer");
  globalThis.Buffer ??= Buffer;
  const [{ KeyPair }, { nep413Digest }] = await Promise.all([import("near-api-js"), import("../nep413")]);
  const key = KeyPair.fromString(secretKey as Parameters<typeof KeyPair.fromString>[0]);
  keys.set(accountId, {
    accountId,
    publicKey,
    async signMessage(payload) {
      const digest = await nep413Digest(payload);
      return {
        accountId,
        publicKey,
        signature: btoa(String.fromCharCode(...key.sign(digest).signature)),
      };
    },
    async signAndSendTransaction(input) {
      if (!import.meta.env.DEV) throw new Error("demo transactions are development-only");
      const { connect, keyStores } = await import("near-api-js");
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey(import.meta.env.VITE_NEAR_NETWORK ?? "testnet", accountId, key);
      const near = await connect({
        networkId: import.meta.env.VITE_NEAR_NETWORK ?? "testnet",
        nodeUrl: import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com",
        keyStore,
        deps: { keyStore },
      });
      const account = await near.account(accountId);
      const outcome = await account.functionCall({
        contractId: input.receiverId,
        methodName: input.methodName,
        args: input.args,
        gas: input.gas ?? 30_000_000_000_000n,
        attachedDeposit: input.deposit ?? 0n,
      });
      return { txHash: outcome.transaction_outcome.id };
    },
  });
}

export function demoSigner(accountId: string): MessageSigner | null {
  const key = keys.get(accountId);
  return key
    ? {
        accountId: key.accountId,
        signMessage: (payload) => key.signMessage(payload),
      }
    : null;
}

export function clearDemoKeys(): void {
  keys.clear();
}

export async function demoTransaction(
  accountId: string,
  input: SendTransactionInput,
): Promise<{ txHash: string } | null> {
  const key = keys.get(accountId);
  return key ? key.signAndSendTransaction(input) : null;
}
