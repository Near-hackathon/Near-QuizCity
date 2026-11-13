import type { Nep413Payload } from "../nep413";

export type WalletAccount = {
  accountId: string;
  publicKey?: string;
};

export type WalletSession = {
  accountId: string;
  publicKey?: string;
  networkId: string;
  walletId: string;
  authenticatedAt: string;
};

export type WalletSignedMessage = {
  accountId: string;
  publicKey: string;
  signature: string;
};

export type WalletRedirectResult = WalletSignedMessage | { txHash: string } | { account: WalletAccount };

export type SendTransactionInput = {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas?: bigint;
  deposit?: bigint;
};

export interface WalletConnector {
  readonly id: string;
  readonly networkId: string;
  readonly contractId: string;
  initialize(): Promise<void>;
  getAccounts(): Promise<WalletAccount[]>;
  signIn(): Promise<WalletAccount[] | null>;
  signOut(): Promise<void>;
  signMessage(payload: Nep413Payload): Promise<WalletSignedMessage | null>;
  signAndSendTransaction(input: SendTransactionInput): Promise<{ txHash: string } | null>;
  onAccountsChange(callback: (accounts: WalletAccount[]) => void): () => void;
  recoverRedirect(): Promise<WalletRedirectResult | null>;
}

export type MessageSigner = {
  accountId: string;
  signMessage(payload: Nep413Payload): Promise<WalletSignedMessage>;
};
