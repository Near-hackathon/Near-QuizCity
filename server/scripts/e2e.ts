import { readFileSync } from "node:fs";
import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import { viewContract } from "../src/near.js";

import { config } from "../src/runtime-config.js";

const API = config.e2eApi;
const CONTRACT = config.contractId;
const RPC = config.rpcUrl;
const NETWORK = config.networkId;
const ALICE = "alice-quizcity.testnet";
const BOB = "bob-quizcity.testnet";

type ChainPlayer = { username: string; starter_claimed: boolean };

const accounts = JSON.parse(
  readFileSync(new URL("../demo-accounts.json", import.meta.url), "utf8"),
) as Record<string, { secretKey: string }>;

const sessions = new Map<string, Account>();

async function account(id: string): Promise<Account> {
  const cached = sessions.get(id);
  if (cached) return cached;
  const keyStore = new keyStores.InMemoryKeyStore();
  const secret = accounts[id]?.secretKey;
  if (!secret) throw new Error(`no demo key for ${id}`);
  await keyStore.setKey(NETWORK, id, KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]));
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore, deps: { keyStore } });
  const acc = await near.account(id);
  sessions.set(id, acc);
  return acc;
}

async function tx(signer: string, method: string, args: Record<string, unknown>): Promise<string> {
  const acc = await account(signer);
  const outcome = await acc.functionCall({
    contractId: CONTRACT,
    methodName: method,
    args,
    gas: 30_000_000_000_000n,
    attachedDeposit: 0n,
  });
  return outcome.transaction_outcome.id;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function onboard(id: string, username: string) {
  const chain = await viewContract<ChainPlayer | null>("get_player", { account: id });
  if (!chain) {
    const hash = await tx(id, "register_player", { username });
    console.log(id, "register", hash);
    await post("/players/register", { accountId: id, txHash: hash });
  }
  const after = await viewContract<ChainPlayer>("get_player", { account: id });
  if (!after.starter_claimed) {
    const hash = await tx(id, "claim_starter", {});
    console.log(id, "claim", hash);
    await post("/players/claim", { accountId: id, txHash: hash });
  }
}

await onboard(ALICE, "alice");
await onboard(BOB, "bob");

const jobs = await get<Record<string, unknown>[]>("/jobs");
let job = jobs.find((j) => j.id === "job-research-1");
if (job && job.status === "open") {
  console.log(
    "accept",
    (await post<{ status: string }>("/jobs/job-research-1/accept", { accountId: ALICE })).status,
  );
  job = (await get<Record<string, unknown>[]>("/jobs")).find((j) => j.id === "job-research-1");
}
if (job && job.status !== "paid") {
  const done = await post<{ txHash: string; balance: string }>("/jobs/job-research-1/complete", {
    accountId: ALICE,
  });
  console.log("job paid", done.txHash, "balance", done.balance);
}

const quizStart = await post<{ attemptId: string }>("/quizzes/daily-quiz/start", { accountId: ALICE });
const quiz = await post<Record<string, unknown>>("/quizzes/daily-quiz/submit", {
  accountId: ALICE,
  attemptId: quizStart.attemptId,
  answers: {
    "q-testnet": 0,
    "q-qc": 1,
    "q-district": 2,
    "q-sink": 2,
    "q-business": 0,
    "q-mayor": 1,
    "q-integrity": 1,
    "q-nep": 1,
  },
});
console.log("quiz", quiz);

const properties = await get<Record<string, unknown>[]>("/properties");
const plot = properties.find((p) => Number(p.id) === 1);
if (plot && plot.owner_wallet !== `player:${ALICE}`) {
  const bought = await post<{ property: { owner: string }; price: number }>("/properties/1/buy", {
    accountId: ALICE,
    txHash: await tx(ALICE, "buy_property", { property_id: 1 }),
  });
  console.log("buy", bought.price, "->", bought.property.owner);
}

let businesses = await get<Record<string, unknown>[]>("/businesses");
if (businesses.length === 0) {
  const biz = await post<Record<string, unknown>>("/businesses", {
    accountId: ALICE,
    propertyId: 1,
    name: "Central Quiz Centre",
    txHash: await tx(ALICE, "create_business", { property_id: 1, name: "Central Quiz Centre" }),
  });
  console.log("business", biz);
  businesses = await get<Record<string, unknown>[]>("/businesses");
}

const business = businesses[0];
if (business && business.owner_account === ALICE) {
  const wallets = await get<{ wallet_id: string; balance: string }[]>("/wallets");
  const treasury = business.treasury_wallet as string;
  const treasuryBalance = wallets.find((w) => w.wallet_id === treasury)?.balance ?? "0";
  if (treasuryBalance === "0") {
    await post("/businesses/1/pay", {
      accountId: BOB,
      amount: 20,
      txHash: await tx(BOB, "pay_service", { business_id: 1, amount: "20" }),
    });
    console.log("bob paid 20");
  }
  const transferred = await post<{ business: { owner: string } }>("/businesses/1/transfer", {
    accountId: ALICE,
    newOwner: BOB,
    txHash: await tx(ALICE, "transfer_business", { business_id: 1, new_owner: BOB }),
  });
  console.log("business owner ->", transferred.business.owner);
} else {
  console.log("business already transferred");
}

console.log("wallets", await get("/wallets"));
console.log("economy", await get("/economy"));
