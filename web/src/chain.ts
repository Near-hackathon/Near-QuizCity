/** Compatibility re-exports for the non-SDK chain helpers used by the UI. */
export { CONTRACT, NETWORK, explorerTx, viewContract as view } from "./wallet/rpc";

export type ChainPlayer = {
  username: string;
  created_at: number;
  starter_claimed: boolean;
};

export { loadWalletSession as loadSession } from "./wallet/session";
import { clearWalletSession, saveWalletSession } from "./wallet/session";
import type { WalletSession } from "./wallet/types";
export function clearSession() {
  clearWalletSession();
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("qc:session-changed"));
}
export function saveSession(session: WalletSession) {
  saveWalletSession(session);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("qc:session-changed"));
}
export type { WalletSession as Session } from "./wallet/types";
