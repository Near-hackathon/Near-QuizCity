import type { WalletSession } from "./types";

const STORAGE_KEY = "quizcity.wallet-session.v1";

export function loadWalletSession(): WalletSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WalletSession>;
    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.networkId !== "string" ||
      typeof parsed.walletId !== "string" ||
      typeof parsed.authenticatedAt !== "string"
    ) {
      return null;
    }
    return {
      profileId: typeof parsed.profileId === "string" ? parsed.profileId : undefined,
      accountId: parsed.accountId,
      publicKey: typeof parsed.publicKey === "string" ? parsed.publicKey : undefined,
      networkId: parsed.networkId,
      walletId: parsed.walletId,
      authenticatedAt: parsed.authenticatedAt,
    };
  } catch {
    return null;
  }
}

export function saveWalletSession(session: WalletSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearWalletSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
