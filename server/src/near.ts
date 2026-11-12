import { providers } from "near-api-js";
import { config } from "./runtime-config.js";

export const contractId = config.contractId;
export const networkId = config.networkId;

const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });

export async function viewContract<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = (await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as unknown as { result: number[] };
  if (!response.result || response.result.length === 0) {
    return null as T;
  }
  return JSON.parse(Buffer.from(response.result).toString("utf8")) as T;
}

export type ContractStats = {
  players: number;
  properties: number;
  businesses: number;
  total_issued: string;
  total_burned: string;
  tx_count: number;
};

export type ContractProperty = {
  id: number;
  kind: string;
  district: string;
  x: number;
  y: number;
  owner: string;
  price: string;
  for_sale: boolean;
  transfer_count: number;
};

export type ContractBusiness = {
  id: number;
  name: string;
  owner: string;
  property_id: number;
  treasury: string;
  revenue_total: string;
};
