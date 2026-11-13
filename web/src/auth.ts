import { api, type AuthMe } from "./api";
import type { Session } from "./chain";
import { decodeNonce, nep413Digest, type Nep413Payload } from "./nep413";

export type LoginSigner = {
  accountId: string;
  publicKey: string;
  signMessage(payload: Nep413Payload): Promise<Uint8Array>;
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function demoSigner(session: Session): Promise<LoginSigner | null> {
  if (!session.secretKey) return null;
  const { KeyPair } = await import("near-api-js");
  const key = KeyPair.fromString(session.secretKey as Parameters<typeof KeyPair.fromString>[0]);
  return {
    accountId: session.accountId,
    publicKey: session.publicKey,
    async signMessage(payload) {
      return key.sign(await nep413Digest(payload)).signature;
    },
  };
}

type WalletProvider = {
  signMessage?: (input: Nep413Payload) => Promise<{
    signature: string;
    publicKey: string;
    accountId?: string;
  }>;
};

function walletSigner(): LoginSigner | null {
  const provider = (globalThis as { nearWallet?: WalletProvider }).nearWallet;
  if (!provider?.signMessage) return null;
  let accountId = "";
  let publicKey = "";
  return {
    get accountId() {
      return accountId;
    },
    get publicKey() {
      return publicKey;
    },
    async signMessage(payload) {
      const result = await provider.signMessage!(payload);
      accountId = result.accountId ?? "";
      publicKey = result.publicKey;
      return Uint8Array.from(atob(result.signature), (character) => character.charCodeAt(0));
    },
  } as LoginSigner;
}

export async function ensureAuth(session: Session, allowDemoSigner: boolean): Promise<AuthMe> {
  try {
    const me = await api.authMe();
    if (me.accountId === session.accountId) return me;
  } catch {
    // no active session; continue with a fresh login
  }

  const nonce = await api.authNonce(session.accountId);
  const signer = allowDemoSigner ? await demoSigner(session) : walletSigner();
  if (!signer) {
    throw new Error(
      "wallet sign-in is not configured; demo sign-in requires DEMO_MODE=1 and a local disposable key",
    );
  }
  const signature = await signer.signMessage({
    message: nonce.message,
    recipient: nonce.recipient,
    nonce: decodeNonce(nonce.nonce),
    callbackUrl: nonce.callbackUrl ?? nonce.domain,
  });
  if (signer.accountId && signer.accountId !== session.accountId) {
    throw new Error("wallet returned a different account than the one requested");
  }
  return api.authVerify({
    accountId: session.accountId,
    publicKey: signer.publicKey || session.publicKey,
    signature: base64(signature),
    nonce: nonce.nonce,
  });
}

export async function logout(): Promise<void> {
  try {
    await api.authLogout();
  } catch {
    // clear local state even if the server session already expired
  }
}
