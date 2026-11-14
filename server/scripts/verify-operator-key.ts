import { providers } from "near-api-js";
import {
  AccessKeyPolicyError,
  assertRestrictedPayoutKey,
  type AccessKeyView,
  type FunctionCallPermission,
} from "../src/access-key.js";

import { CITY_PAYOUT_METHODS } from "../src/testnet-upgrade.js";
const DEFAULT_METHODS = [...CITY_PAYOUT_METHODS];

function usage(): string {
  return `Usage: node --env-file=.env --import tsx scripts/verify-operator-key.ts --public-key <ed25519:...> [options]

Read-only check of the server's payout key. It never accepts or prints a private key.

Options:
  --public-key <key>   Public key to inspect (required).
  --account <id>       Account that owns the key (default: NEAR_OPERATOR_ACCOUNT).
  --receiver <id>      Expected contract receiver (default: NEAR_CONTRACT_ID).
  --methods <a,b>      Exact allowed methods (default: ${DEFAULT_METHODS.join(",")}).
  --rpc <url>          RPC endpoint (default: NEAR_RPC_URL or testnet fastnear).
  --help               Show this message.`;
}

type Options = {
  publicKey: string;
  account: string;
  receiver: string;
  methods: string[];
  rpc: string;
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Options | null {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return null;
    if (/private|secret|seed/i.test(arg)) {
      fail(`${arg} is not accepted: this script inspects public keys only.`);
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
    values[arg.slice(2)] = value;
    index += 1;
  }

  const publicKey = values["public-key"];
  if (!publicKey) fail("--public-key is required");
  const account = values.account ?? process.env.NEAR_OPERATOR_ACCOUNT;
  if (!account) fail("--account or NEAR_OPERATOR_ACCOUNT is required");
  const receiver = values.receiver ?? process.env.NEAR_CONTRACT_ID;
  if (!receiver) fail("--receiver or NEAR_CONTRACT_ID is required");
  const methods = values.methods ? values.methods.split(",").map((method) => method.trim()) : DEFAULT_METHODS;
  if (methods.length === 0 || methods.some((method) => method.length === 0))
    fail("--methods must be a non-empty list");
  const rpc = values.rpc ?? process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";

  return { publicKey, account, receiver, methods, rpc };
}

function summarize(account: string, publicKey: string, permission: FunctionCallPermission): string {
  return [
    `account: ${account}`,
    `public key: ${publicKey}`,
    "permission: FunctionCall",
    `receiver: ${permission.receiver_id}`,
    `methods: ${permission.method_names.join(", ")}`,
    `allowance: ${permission.allowance ?? "none"}`,
  ].join("\n");
}

const options = parseArgs(process.argv.slice(2));
if (!options) {
  console.log(usage());
  process.exit(0);
}

const provider = new providers.JsonRpcProvider({ url: options.rpc });
let key: AccessKeyView;
try {
  key = (await provider.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: options.account,
    public_key: options.publicKey,
  })) as unknown as AccessKeyView;
} catch (error) {
  console.error(`could not read access key ${options.publicKey} for ${options.account}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

try {
  const permission = assertRestrictedPayoutKey(key.permission, {
    receiverId: options.receiver,
    methods: options.methods,
  });
  console.log(summarize(options.account, options.publicKey, permission));
  console.log("server payout key is restricted and verified");
} catch (error) {
  if (error instanceof AccessKeyPolicyError) {
    console.error(`server payout key failed verification: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
