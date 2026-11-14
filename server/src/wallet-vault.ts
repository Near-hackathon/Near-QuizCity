import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
/** AES-GCM binds every ciphertext to its resident, network and account. */
export function sealWalletKey(key: string, secret: string, context: string): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  cipher.setAAD(Buffer.from(`quizcity:wallet:v1:${context}`));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(".");
}
export function openWalletKey(key: string, envelope: string, context: string): string {
  try {
    const [version, nonce, tag, data, ...rest] = envelope.split(".");
    if (version !== "v1" || rest.length || !nonce || !tag || !data) throw Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      Buffer.from(nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(`quizcity:wallet:v1:${context}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const secret = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
      "utf8",
    );
    KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]);
    return secret;
  } catch {
    throw Error("The testnet wallet key could not be unlocked. Check the configured encryption key.");
  }
}
export const walletContext = (profileId: string, accountId: string) => `testnet:${profileId}:${accountId}`;
export function canonicalWalletArgs(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalWalletArgs).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalWalletArgs(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const walletRequestHash = (method: string, args: Record<string, unknown>) =>
  createHash("sha256").update(canonicalWalletArgs({ method, args })).digest("hex");
