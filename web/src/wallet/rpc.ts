const NETWORK = import.meta.env.VITE_NEAR_NETWORK ?? "testnet";
const RPC = import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const CONTRACT = import.meta.env.VITE_CONTRACT_ID ?? "quizcity.testnet";

function encodeArgs(args: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Read-only contract view without importing a NEAR SDK into the entry bundle. */
export async function viewContract<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "quiz-city-view",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT,
        method_name: method,
        args_base64: encodeArgs(args),
      },
    }),
  });
  if (!response.ok) throw new Error(`chain view failed: ${response.status}`);
  const payload = (await response.json()) as {
    error?: unknown;
    result?: { result?: number[] };
  };
  if (payload.error || !payload.result?.result) {
    throw new Error("chain view failed");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(payload.result.result))) as T;
}

export function explorerTx(hash: string): string {
  return NETWORK === "mainnet"
    ? `https://nearblocks.io/txns/${hash}`
    : `https://testnet.nearblocks.io/txns/${hash}`;
}

export { CONTRACT, NETWORK, RPC };
