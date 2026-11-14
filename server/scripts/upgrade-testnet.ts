/** Explicit administrator stages. No private key is accepted as an argument or printed. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, rename, access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { connect, keyStores, KeyPair, providers, transactions, utils } from "near-api-js";
import { config } from "../src/runtime-config.js";
import { isValidAccountId } from "../src/config.js";
import { assertRestrictedPayoutKey } from "../src/access-key.js";
import {
  assertTestnetUpgradeTarget,
  assertUpgradeProof,
  digest,
  CITY_PAYOUT_METHODS,
  UPGRADE_ALLOWANCE,
} from "../src/testnet-upgrade.js";
import { assertWasmExports } from "../../scripts/wasm-exports.mjs";
assertTestnetUpgradeTarget(config);
const root = fileURLToPath(new URL("../../", import.meta.url));
const workspaceId = digest(root).slice(0, 16);
const directory = resolve(homedir(), ".config", "quiz-city", workspaceId, "deployment", config.contractId);
const envPath = resolve(root, "server/.env"),
  wasmPath = resolve(root, "contract/target/near/quizcity-production.wasm");
const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
const mode = process.argv[2] ?? "--audit";
if (
  process.argv.length > 3 ||
  !["--prepare", "--secure", "--deploy", "--switch-server", "--audit"].includes(mode)
)
  throw Error("Choose --audit, --prepare, --secure, --deploy or --switch-server.");
const json = async (name: string) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
const save = async (name: string, data: unknown) =>
  writeFile(resolve(directory, name), JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
let operation = "starting";
const query = async (
  request_type: string,
  more: Record<string, unknown> = {},
  block_id?: string,
): Promise<any> => {
  operation = `query:${request_type}:${more.method_name ?? ""}`;
  try {
    return await provider.query({
      request_type,
      account_id: config.contractId,
      ...(block_id ? { block_id } : { finality: "final" }),
      ...more,
    } as never);
  } catch (e) {
    const kind = String((e as any)?.type ?? (e as any)?.code ?? "RPC_ERROR")
      .replace(/[^A-Za-z0-9_]/g, "")
      .slice(0, 60);
    throw Error(`Read-only ${request_type} ${more.method_name ?? ""} failed (${kind}).`, { cause: e });
  }
};
const view = async (method: string, args: Record<string, unknown> = {}, block?: string) => {
  const r = await query(
    "call_function",
    { method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    block,
  );
  return JSON.parse(Buffer.from(r.result).toString());
};
const keypair = (entry: { private_key: string }) => KeyPair.fromString(entry.private_key as never);
const account = async (key: ReturnType<typeof KeyPair.fromRandom>) => {
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey("testnet", config.contractId, key);
  return (await connect({ networkId: "testnet", nodeUrl: config.rpcUrl, keyStore: store })).account(
    config.contractId,
  );
};
const keyView = async (pub: string, finality: "final" | "optimistic" = "final") =>
  provider.query({
    request_type: "view_access_key",
    finality,
    account_id: config.contractId,
    public_key: pub,
  }) as Promise<any>;
const txId = (o: any) => o.transaction_outcome.id as string;
async function keyFile(name: string) {
  try {
    return await json(name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const key = KeyPair.fromRandom("ed25519"),
    entry = {
      account_id: config.contractId,
      public_key: key.getPublicKey().toString(),
      private_key: key.toString(),
    };
  await save(name, entry);
  return entry;
}
async function backupDatabase() {
  const path = resolve(directory, "database.before.dump");
  try {
    if ((await stat(path)).size > 0) return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const database = new URL(config.databaseUrl);
  const result = spawnSync("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file=" + path], {
    env: {
      ...process.env,
      PGHOST: database.hostname,
      PGPORT: database.port || "5432",
      PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
      PGUSER: decodeURIComponent(database.username),
      PGPASSWORD: decodeURIComponent(database.password),
      PGSSLMODE: config.pgSsl === "require" ? "require" : "disable",
    },
    stdio: "pipe",
  });
  if (result.status !== 0)
    throw Error(
      "The database backup could not be completed; use a matching pg_dump version and database credentials. No live changes were made.",
    );
  await chmod(path, 0o600);
}
async function main() {
  if (mode === "--prepare") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    // Keep existing credentials on resume; never regenerate the deploy/recovery key.
    await keyFile("recovery-key.json");
    await keyFile("payout-key.json");
    try {
      await access(resolve(directory, "previous-server-key.json"));
    } catch {
      const key = KeyPair.fromString(config.operatorPrivateKey as never);
      await save("previous-server-key.json", {
        account_id: config.contractId,
        public_key: key.getPublicKey().toString(),
        private_key: key.toString(),
      });
    }
    try {
      await access(resolve(directory, "server.env.before"));
    } catch {
      await writeFile(resolve(directory, "server.env.before"), await readFile(envPath), {
        mode: 0o600,
        flag: "wx",
      });
    }
    let existingSnapshot;
    try {
      existingSnapshot = await json("snapshot.json");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (existingSnapshot) {
      await backupDatabase();
      console.log(
        JSON.stringify({ prepared: directory, reusedSnapshot: true, codeHash: existingSnapshot.codeHash }),
      );
      return;
    }
    const block = await provider.block({ finality: "final" }),
      at = block.header.hash;
    const native = await query("view_account", {}, at),
      keys = await query("view_access_key_list", {}, at),
      state = await query("view_state", { prefix_base64: "", include_proof: false }, at),
      code = await query("view_code", {}, at);
    const bytes = Buffer.from(code.code_base64, "base64");
    if (utils.serialize.base_encode(createHash("sha256").update(bytes).digest()) !== native.code_hash)
      throw Error("Downloaded code hash does not match account.");
    const accounts = new Set<string>(),
      walletIds = new Set<string>();
    // UnorderedMap key vectors contain exact Borsh strings. Discover identifiers
    // from public storage, then validate each through contract views and counts.
    for (const record of state.values) {
      const value = Buffer.from(record.value, "base64");
      if (value.length < 4 || value.readUInt32LE(0) !== value.length - 4) continue;
      const text = value.subarray(4).toString("utf8");
      if (isValidAccountId(text)) accounts.add(text);
      if (/^(player|npc|gov|biz):[a-z0-9._-]+$/.test(text)) walletIds.add(text);
    }
    const facts = {
      stats: await view("get_stats", {}, at),
      properties: await view("get_properties", { from_index: 0, limit: 100 }, at),
      businesses: await view("get_businesses", { from_index: 0, limit: 100 }, at),
      players: [] as any[],
      wallets: [] as any[],
    };
    for (const accountId of [...accounts].sort()) {
      const value = await view("get_player", { account: accountId }, at);
      if (value) facts.players.push({ accountId, value });
    }
    if (facts.players.length !== facts.stats.players) throw Error("Player inventory is incomplete.");
    for (const wallet of [...walletIds].sort())
      facts.wallets.push({ wallet, balance: await view("get_balance", { wallet }, at) });
    if (
      facts.wallets.reduce((sum, w) => sum + BigInt(w.balance), 0n) !==
      BigInt(facts.stats.total_issued) - BigInt(facts.stats.total_burned)
    )
      throw Error("Wallet inventory supply is incomplete.");
    if (
      facts.properties.length !== facts.stats.properties ||
      facts.businesses.length !== facts.stats.businesses
    )
      throw Error("Asset inventory is incomplete.");
    const snapshot = {
      accountId: config.contractId,
      blockHash: at,
      blockHeight: String(block.header.height),
      codeHash: native.code_hash,
      wasmSha256: digest(bytes),
      native,
      keys: keys.keys,
      values: state.values,
      facts,
    };
    await save("snapshot.json", snapshot);
    await writeFile(resolve(directory, "previous.wasm"), bytes, { mode: 0o600, flag: "wx" });
    await backupDatabase();
    console.log(
      JSON.stringify({
        prepared: directory,
        codeHash: snapshot.codeHash,
        blockHeight: snapshot.blockHeight,
        stats: facts.stats,
        stateRecords: state.values.length,
      }),
    );
    return;
  }
  if (mode === "--secure") {
    const recovery = await json("recovery-key.json"),
      payout = await json("payout-key.json"),
      old = await json("previous-server-key.json");
    const keys = await query("view_access_key_list");
    if (!keys.keys.some((k: any) => k.public_key === recovery.public_key)) {
      if ((await keyView(old.public_key)).permission !== "FullAccess")
        throw Error("The existing administrator key must be full access.");
      const result = await (await account(keypair(old))).addKey(recovery.public_key);
      await save("recovery-added.json", { txHash: txId(result), publicKey: recovery.public_key });
    }
    if ((await keyView(recovery.public_key, "optimistic")).permission !== "FullAccess")
      throw Error("Recovery access was not confirmed.");
    const current = (await provider.query({
      request_type: "view_access_key_list",
      finality: "optimistic",
      account_id: config.contractId,
    })) as any;
    if (!current.keys.some((k: any) => k.public_key === payout.public_key)) {
      // Signing this operation proves recovery access before the old key is touched.
      const result = await (
        await account(keypair(recovery))
      ).addKey(payout.public_key, config.contractId, [...CITY_PAYOUT_METHODS], UPGRADE_ALLOWANCE);
      await save("payout-added.json", { txHash: txId(result), publicKey: payout.public_key });
    }
    assertRestrictedPayoutKey((await keyView(payout.public_key, "optimistic")).permission, {
      receiverId: config.contractId,
      methods: CITY_PAYOUT_METHODS,
    });
    console.log(
      JSON.stringify({
        recoveryPublicKey: recovery.public_key,
        payoutPublicKey: payout.public_key,
        methods: CITY_PAYOUT_METHODS,
        allowance: UPGRADE_ALLOWANCE.toString(),
        oldKeyRetained: true,
      }),
    );
    return;
  }
  if (mode === "--deploy") {
    const raw = await readFile(resolve(directory, "snapshot.json"), "utf8"),
      snapshot = JSON.parse(raw),
      proof = await json("rehearsal.json"),
      wasm = await readFile(wasmPath);
    assertWasmExports(wasm, { demo: false });
    assertUpgradeProof(snapshot, wasm, raw, proof);
    const native = await query("view_account");
    if (native.code_hash !== snapshot.codeHash) throw Error("The live code changed after preparation.");
    const state = await query("view_state", { prefix_base64: "", include_proof: false });
    const canonical = (rows: any[]) => JSON.stringify([...rows].sort((a, b) => a.key.localeCompare(b.key)));
    if (canonical(state.values) !== canonical(snapshot.values))
      throw Error("Live storage changed since rehearsal; take a new reviewed snapshot.");
    const recovery = await json("recovery-key.json");
    if ((await keyView(recovery.public_key)).permission !== "FullAccess")
      throw Error("Recovery permission is not final.");
    const result = await (
      await account(keypair(recovery))
    ).signAndSendTransaction({
      receiverId: config.contractId,
      actions: [
        transactions.deployContract(wasm),
        transactions.functionCall("migrate_economy", {}, 150000000000000n, 0n),
      ],
    });
    // Deploy and migration share one receipt, so migration failure rolls back code too.
    await save("deployment.json", {
      txHash: txId(result),
      wasmSha256: digest(wasm),
      codeHash: utils.serialize.base_encode(createHash("sha256").update(wasm).digest()),
      previousCodeHash: snapshot.codeHash,
    });
    console.log(JSON.stringify(await json("deployment.json")));
    return;
  }
  if (mode === "--switch-server") {
    const deployed = await json("deployment.json"),
      native = await query("view_account");
    if (native.code_hash !== deployed.codeHash || (await view("supports_city_economy")) !== true)
      throw Error("The reviewed contract is not confirmed.");
    const payout = await json("payout-key.json");
    assertRestrictedPayoutKey((await keyView(payout.public_key)).permission, {
      receiverId: config.contractId,
      methods: CITY_PAYOUT_METHODS,
    });
    const source = await readFile(envPath, "utf8");
    if (!/^NEAR_OPERATOR_PRIVATE_KEY\s*=.*$/m.test(source))
      throw Error("Operator configuration line was not found.");
    const next = source.replace(
      /^NEAR_OPERATOR_PRIVATE_KEY\s*=.*$/m,
      "NEAR_OPERATOR_PRIVATE_KEY=" + payout.private_key,
    );
    const temporary = envPath + ".upgrade.tmp";
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    await rename(temporary, envPath);
    console.log(
      JSON.stringify({
        serverPublicKey: payout.public_key,
        permission: "FunctionCall",
        oldKeyRetained: true,
      }),
    );
    return;
  }
  console.log(
    JSON.stringify({
      directory,
      account: config.contractId,
      native: await query("view_account"),
      keys: (await query("view_access_key_list")).keys,
      stats: await view("get_stats"),
    }),
  );
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      stage: operation,
      code: (error as any)?.code ?? (error as any)?.type ?? "UPGRADE_STOPPED",
      safeMessage:
        error instanceof Error &&
        /^(Read-only|Player inventory|Downloaded code|The database backup)/.test(error.message)
          ? error.message
          : "Stage could not complete.",
    }),
  );
  console.error(
    "Testnet upgrade stopped. Existing keys/backups were retained. Inspect the public audit and saved stage journal before retrying.",
  );
  process.exitCode = 1;
});
