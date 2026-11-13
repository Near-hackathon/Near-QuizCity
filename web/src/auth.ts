import { api, type AuthMe } from "./api";
import { decodeNonce } from "./nep413";
import type { MessageSigner } from "./wallet/types";

export async function ensureAuth(accountId: string, signer: MessageSigner): Promise<AuthMe> {
  try {
    const me = await api.authMe();
    if (me.accountId === accountId) return me;
  } catch {
    // no active server session; continue with a fresh login
  }

  const nonce = await api.authNonce(accountId);
  const signed = await signer.signMessage({
    message: nonce.message,
    recipient: nonce.recipient,
    nonce: decodeNonce(nonce.nonce),
    callbackUrl: nonce.callbackUrl ?? nonce.domain,
  });
  if (signed.accountId !== accountId) {
    throw new Error("wallet returned a different account than the one requested");
  }
  return api.authVerify({
    accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    nonce: nonce.nonce,
  });
}

export async function logout(): Promise<void> {
  try {
    await api.authLogout();
  } catch {
    // the server session may already be expired
  } finally {
    api.clearCsrf();
  }
}
