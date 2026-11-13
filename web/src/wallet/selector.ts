import type { Nep413Payload } from "../nep413";
import type {
  MessageSigner,
  SendTransactionInput,
  WalletAccount,
  WalletConnector,
  WalletSignedMessage,
} from "./types";

const WALLET_ID = "my-near-wallet";
const ACCOUNT_KEY = "quizcity.my-near-wallet.account.v1";
const PLACEHOLDER_PUBLIC_KEY = "ed25519:11111111111111111111111111111111";

type WalletMessage = {
  status?: "success" | "failure";
  account_id?: string;
  public_key?: string;
  transactionHashes?: string;
  signedRequest?: WalletSignedMessage;
  error?: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function openWalletPopup(walletUrl: string, target: URL): Promise<WalletMessage> {
  const width = 480;
  const height = 700;
  const left = Math.max(0, (window.innerWidth - width) / 2);
  const top = Math.max(0, (window.innerHeight - height) / 2);
  const child = window.open(
    target.toString(),
    "MyNearWallet",
    `width=${width},height=${height},top=${top},left=${left}`,
  );
  if (!child) throw new Error("Popup window blocked. Please allow popups for this site.");

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
    };
    const onMessage = (event: MessageEvent<WalletMessage>) => {
      if (event.origin !== new URL(walletUrl).origin) return;
      cleanup();
      child.close();
      if (event.data?.status === "failure") reject(new Error(event.data.error || "wallet request failed"));
      else resolve(event.data);
    };
    window.addEventListener("message", onMessage);
    const closedTimer = window.setInterval(() => {
      if (!child.closed) return;
      cleanup();
      reject(new Error("Wallet window was closed before completion"));
    }, 500);
  });
}

function storedAccount(): WalletAccount | null {
  try {
    const value = localStorage.getItem(ACCOUNT_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<WalletAccount>;
    return typeof parsed.accountId === "string"
      ? { accountId: parsed.accountId, publicKey: parsed.publicKey }
      : null;
  } catch {
    return null;
  }
}

export function createSelectorConnector(networkId: string, contractId: string): WalletConnector {
  const walletUrl =
    networkId === "mainnet" ? "https://app.mynearwallet.com" : "https://testnet.mynearwallet.com";
  const rpcUrl =
    networkId === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";

  return {
    id: WALLET_ID,
    networkId,
    contractId,
    async initialize() {},
    async getAccounts() {
      const account = storedAccount();
      return account ? [account] : [];
    },
    async signIn() {
      const target = new URL("login/", `${walletUrl}/`);
      target.searchParams.set("success_url", window.location.href);
      target.searchParams.set("failure_url", window.location.href);
      const result = await openWalletPopup(walletUrl, target);
      if (!result.account_id) return null;
      const account = { accountId: result.account_id, publicKey: result.public_key || undefined };
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
      window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_KEY }));
      return [account];
    },
    async signOut() {
      localStorage.removeItem(ACCOUNT_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_KEY }));
    },
    async signMessage(payload: Nep413Payload) {
      const target = new URL("sign-message", `${walletUrl}/`);
      target.searchParams.set("message", payload.message);
      target.searchParams.set("nonce", bytesToBase64(payload.nonce));
      target.searchParams.set("recipient", payload.recipient);
      target.searchParams.set("callbackUrl", payload.callbackUrl ?? window.location.href);
      const result = await openWalletPopup(walletUrl, target);
      return result.signedRequest ?? null;
    },
    async signAndSendTransaction(input: SendTransactionInput) {
      const account = storedAccount();
      if (!account) throw new Error("wallet is not signed in");
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "quiz-city-wallet-block",
          method: "block",
          params: { finality: "final" },
        }),
      });
      if (!response.ok) throw new Error(`wallet block lookup failed: ${response.status}`);
      const block = (await response.json()) as { result?: { header?: { hash?: string } }; error?: unknown };
      const blockHash = block.result?.header?.hash;
      if (block.error || !blockHash) throw new Error("wallet block lookup returned an invalid response");

      const [{ createTransaction, encodeTransaction, actionCreators }, { PublicKey }, { baseDecode }] =
        await Promise.all([
          import("@near-js/transactions"),
          import("@near-js/crypto"),
          import("@near-js/utils"),
        ]);
      const transaction = createTransaction(
        account.accountId,
        PublicKey.fromString(account.publicKey || PLACEHOLDER_PUBLIC_KEY),
        input.receiverId,
        0,
        [
          actionCreators.functionCall(
            input.methodName,
            input.args,
            input.gas ?? 30_000_000_000_000n,
            input.deposit ?? 0n,
          ),
        ],
        baseDecode(blockHash),
      );
      const target = new URL("sign", `${walletUrl}/`);
      target.searchParams.set("transactions", bytesToBase64(encodeTransaction(transaction)));
      target.searchParams.set("callbackUrl", window.location.href);
      const result = await openWalletPopup(walletUrl, target);
      const txHash = result.transactionHashes?.split(",")[0];
      return txHash ? { txHash } : null;
    },
    onAccountsChange(callback) {
      const handler = (event: StorageEvent) => {
        if (event.key !== ACCOUNT_KEY) return;
        const account = storedAccount();
        callback(account ? [account] : []);
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    async recoverRedirect() {
      const params = new URLSearchParams(window.location.search);
      const error = params.get("errorCode") ?? params.get("errorMessage");
      if (error) throw new Error(`wallet callback failed: ${error}`);
      const txHash = params.get("transactionHashes")?.split(",")[0];
      if (txHash) return { txHash };
      const accountId = params.get("account_id");
      if (accountId) {
        const account = { accountId, publicKey: params.get("public_key") || undefined };
        localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
        return { account };
      }
      const account = storedAccount();
      return account ? { account } : null;
    },
  };
}

export function signerFromConnector(connector: WalletConnector, accountId: string): MessageSigner {
  return {
    accountId,
    async signMessage(payload) {
      const signed = await connector.signMessage(payload);
      if (!signed) throw new Error("wallet returned no signature");
      if (signed.accountId !== accountId) throw new Error("wallet signed a different account");
      return signed;
    },
  };
}
