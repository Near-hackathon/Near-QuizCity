import { KeyPair, providers, transactions, utils, keyStores, InMemorySigner } from "near-api-js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { ExpectedCall, VerifiedCall } from "./verify.js";
export type SignedWalletTransaction = { hash: string; bytes: string; nonce: string };
export type ManagedWalletChain = {
  accountKeys(accountId: string): Promise<Array<{ publicKey: string; permission: unknown }> | null>;
  createAccount(accountId: string, publicKey: string): Promise<void>;
  supportsGame(): Promise<boolean>;
  sign(
    accountId: string,
    privateKey: string,
    method: string,
    args: Record<string, unknown>,
    lastNonce: string,
  ): Promise<SignedWalletTransaction>;
  broadcast(bytes: string): Promise<void>;
  verify(hash: string, expected: ExpectedCall): Promise<VerifiedCall>;
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  balance(wallet: string): Promise<string>;
};
function unknownAccount(error: unknown): boolean {
  const e = error as { type?: string; cause?: { name?: string } };
  return (
    ["AccountDoesNotExist", "UNKNOWN_ACCOUNT"].includes(e?.type ?? "") || e?.cause?.name === "UNKNOWN_ACCOUNT"
  );
}
type ChainDependencies = {
  provider?: Pick<providers.JsonRpcProvider, "query" | "sendTransaction">;
  fetch?: typeof fetch;
  verify?: (hash: string, expected: ExpectedCall) => Promise<VerifiedCall>;
};
export function createManagedWalletChain(
  cfg: AppConfig,
  dependencies: ChainDependencies = {},
): ManagedWalletChain {
  const provider = dependencies.provider ?? new providers.JsonRpcProvider({ url: cfg.rpcUrl });
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError(
                  "CHAIN_TIMEOUT",
                  "The network is taking longer than expected. Your saved wallet will be rechecked.",
                  504,
                ),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = (await bounded(
      provider.query({
        request_type: "call_function",
        finality: "final",
        account_id: cfg.contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      }),
    )) as unknown as { result: number[] };
    return JSON.parse(Buffer.from(response.result).toString("utf8")) as T;
  };
  return {
    async accountKeys(accountId) {
      try {
        // An access-key list may be empty even when the account does not exist.
        // Confirm native account existence before judging its key permissions.
        await bounded(
          provider.query({ request_type: "view_account", finality: "final", account_id: accountId }),
        );
        const result = (await bounded(
          provider.query({ request_type: "view_access_key_list", finality: "final", account_id: accountId }),
        )) as unknown as { keys: Array<{ public_key: string; access_key: { permission: unknown } }> };
        return result.keys.map((k) => ({ publicKey: k.public_key, permission: k.access_key.permission }));
      } catch (e) {
        if (unknownAccount(e)) return null;
        throw new AppError(
          "CHAIN_UNAVAILABLE",
          "Account access could not be checked. Your saved account will be retried.",
          503,
        );
      }
    },
    async createAccount(accountId, publicKey) {
      let response: Response;
      try {
        response = await (dependencies.fetch ?? fetch)(cfg.testnetWalletFaucetUrl, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new AppError(
          "FAUCET_UNAVAILABLE",
          "The testnet account sponsor is unavailable. Your saved account will be rechecked.",
          503,
        );
      }
      await response.body?.cancel();
      if (!response.ok)
        throw new AppError(
          response.status === 429 ? "FAUCET_RATE_LIMITED" : "FAUCET_UNAVAILABLE",
          "The testnet account sponsor could not finish yet. Your saved account will be rechecked.",
          503,
        );
    },
    async supportsGame() {
      try {
        return (await view<boolean>("supports_city_economy")) === true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/method is not found|MethodNotFound/.test(message)) return false;
        throw new AppError("CHAIN_UNAVAILABLE", "The city contract could not be checked.", 503);
      }
    },
    async sign(accountId, privateKey, method, args, lastNonce) {
      const key = KeyPair.fromString(privateKey as Parameters<typeof KeyPair.fromString>[0]);
      const access = (await bounded(
        provider.query({
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: key.getPublicKey().toString(),
        }),
      )) as unknown as { nonce: number | string; block_hash: string; permission: unknown };
      if (
        access.permission !== "FullAccess" ||
        (typeof access.nonce === "number" && !Number.isSafeInteger(access.nonce))
      )
        throw new AppError("ACCESS_KEY_MISMATCH", "The wallet access policy needs review.", 409);
      const chainNonce = BigInt(access.nonce),
        floor = BigInt(lastNonce),
        nonce = (chainNonce > floor ? chainNonce : floor) + 1n;
      if (nonce > 18446744073709551615n)
        throw new AppError("CONFLICT", "The account nonce has reached its limit.", 409);
      const store = new keyStores.InMemoryKeyStore();
      await store.setKey("testnet", accountId, key);
      const signer = new InMemorySigner(store);
      const tx = transactions.createTransaction(
        accountId,
        key.getPublicKey(),
        cfg.contractId,
        nonce,
        [transactions.functionCall(method, args, 30000000000000n, 0n)],
        utils.serialize.base_decode(access.block_hash),
      );
      const [hash, signed] = await transactions.signTransaction(tx, signer, accountId, "testnet");
      return {
        hash: utils.serialize.base_encode(hash),
        bytes: Buffer.from(signed.encode()).toString("base64"),
        nonce: nonce.toString(),
      };
    },
    async broadcast(bytes) {
      const signed = transactions.SignedTransaction.decode(Buffer.from(bytes, "base64"));
      await bounded(provider.sendTransaction(signed));
    },
    async verify(hash, expected) {
      return bounded(
        dependencies.verify
          ? dependencies.verify(hash, expected)
          : (await import("./verify.js")).verifyExpectedFunctionCall(hash, expected),
      );
    },
    view,
    balance: (wallet) => view<string>("get_balance", { wallet }),
  };
}
