/** Compatibility re-exports for the non-SDK chain helpers used by the UI. */
export { CONTRACT, NETWORK, explorerTx, viewContract as view } from "./wallet/rpc";

export type ChainPlayer = {
  username: string;
  created_at: number;
  starter_claimed: boolean;
};

export {
  clearWalletSession as clearSession,
  loadWalletSession as loadSession,
  saveWalletSession as saveSession,
} from "./wallet/session";
export type { WalletSession as Session } from "./wallet/types";
