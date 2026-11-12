import { connect, keyStores, KeyPair, providers, type Account } from "near-api-js";

const NETWORK = import.meta.env.VITE_NEAR_NETWORK ?? "testnet";
const RPC = import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const CONTRACT = import.meta.env.VITE_CONTRACT_ID ?? "quizcity.testnet";
const STORAGE_KEY = "quizcity.session.v2";

export type Session = {
  accountId: string;
  publicKey: string;
  secretKey: string;
};

export type ChainPlayer = {
  username: string;
  created_at: number;
  starter_claimed: boolean;
};

const provider = new providers.JsonRpcProvider({ url: RPC });

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = (await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: encodeArgs(args),
  })) as unknown as { result: number[] };
  if (!response.result || response.result.length === 0) return null as T;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(response.result))) as T;
}

const accounts = new Map<string, Promise<Account>>();

async function accountFor(session: Session): Promise<Account> {
  const existing = accounts.get(session.accountId);
  if (existing) return existing;
  const promise = (async () => {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      NETWORK,
      session.accountId,
      KeyPair.fromString(session.secretKey as Parameters<typeof KeyPair.fromString>[0]),
    );
    const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore, deps: { keyStore } });
    return near.account(session.accountId);
  })();
  accounts.set(session.accountId, promise);
  return promise;
}

export async function call(
  session: Session,
  method: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const account = await accountFor(session);
  const outcome = await account.functionCall({
    contractId: CONTRACT,
    methodName: method,
    args,
    gas: 30_000_000_000_000n,
    attachedDeposit: 0n,
  });
  return outcome.transaction_outcome.id;
}

function encodeArgs(args: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function explorerTx(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}

export { CONTRACT, NETWORK, RPC };
