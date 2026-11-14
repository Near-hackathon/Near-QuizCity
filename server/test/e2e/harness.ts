import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair } from "near-api-js";
import type { FastifyInstance } from "fastify";
import { AccessKey, Worker, type NearAccount } from "near-workspaces";
import postgres from "postgres";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../../src/migrations.js";
import { nep413Digest } from "../../src/auth/message.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { makeTestConfig } from "../fixtures.js";
import { testDatabaseUrl } from "../db-test-utils.js";
import { runCleanupSteps } from "./cleanup.js";

const wasmPath = fileURLToPath(
  new URL("../../../contract/target/near/quizcity-production.wasm", import.meta.url),
);
const migrations = loadMigrations(fileURLToPath(new URL("../../db/migrations", import.meta.url)));

export type Stack = Awaited<ReturnType<typeof startStack>>;

const yocto = (near: number) => BigInt(near) * 10n ** 24n;
const E2E_SCHEMA_PATTERN = /^quizcity_e2e_[0-9a-f]{16}$/;

function databaseUrlWithSchema(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

export async function callTx(
  account: NearAccount,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await account.callRaw(contractId, method, args);
  if (!result.succeeded) {
    throw new Error(`${method} failed: ${result.failureMessage ?? "unknown chain failure"}`);
  }
  return result.transactionReceipt.hash;
}

export async function startStack(options: { city?: boolean; managed?: boolean } = {}) {
  const payoutMethods = [
    "credit_reward",
    "pay_job",
    ...(options.city ? ["settle_escrow", "npc_purchase"] : []),
  ];
  const baseUrl = testDatabaseUrl();
  const schema = `quizcity_e2e_${randomBytes(8).toString("hex")}`;
  if (!E2E_SCHEMA_PATTERN.test(schema)) throw new Error("refusing unsafe E2E schema name");
  const admin = postgres(baseUrl, { max: 1, ssl: false, onnotice: () => {} });
  let worker: Worker | null = null;
  let app: FastifyInstance | null = null;
  let db: ReturnType<typeof postgres> | null = null;
  let closeApplicationDb: (() => Promise<void>) | null = null;
  let schemaCreated = false;
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await runCleanupSteps([
      {
        name: "fastify",
        run: async () => {
          app?.server.closeAllConnections?.();
          await app?.close();
        },
      },
      {
        name: "application database",
        run: async () => {
          await closeApplicationDb?.();
        },
      },
      { name: "assertion database", run: async () => db?.end({ timeout: 5 }) },
      {
        name: "schema",
        run: async () => {
          if (schemaCreated) await admin.unsafe(`drop schema if exists ${schema} cascade`);
        },
      },
      { name: "admin", run: () => admin.end({ timeout: 5 }) },
      { name: "sandbox", run: async () => worker?.tearDown() },
    ]);
  };

  try {
    await admin.unsafe(`create schema ${schema}`);
    schemaCreated = true;
    await admin.unsafe(`set search_path to ${schema}`);
    await runMigrations(postgresMigrationStore(admin), migrations);

    worker = await Worker.init();
    const root = worker.rootAccount;
    const contract = await root.createSubAccount("quizcity", { initialBalance: yocto(50) });
    const contractId = contract.accountId;
    await contract.deploy(wasmPath);
    await contract.callRaw(contractId, "new", {});

    const operator = await root.createSubAccount("operator", { initialBalance: yocto(20) });
    await contract.callRaw(contractId, "propose_operator", { new_operator: operator.accountId });
    await operator.callRaw(contractId, "accept_operator", {});

    const operatorSigner = KeyPair.fromRandom("ed25519");
    await operator
      .batch(operator.accountId)
      .addKey(
        operatorSigner.getPublicKey(),
        new AccessKey({
          nonce: 0n,
          permission: {
            functionCall: {
              receiverId: contractId,
              methodNames: payoutMethods,
              allowance: yocto(5),
            },
          },
        }),
      )
      .transact();

    const storedKey = (await worker.provider.query({
      request_type: "view_access_key",
      // `transact()` has already executed the add-key receipt. Query the
      // optimistic head so startup does not wait for a later final block that
      // can predate the just-completed receipt in a fresh sandbox.
      finality: "optimistic",
      account_id: operator.accountId,
      public_key: operatorSigner.getPublicKey().toString(),
    })) as {
      permission:
        | "FullAccess"
        | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } };
    };
    if (storedKey.permission === "FullAccess") {
      throw new Error("E2E server operator key must not be full access");
    }
    const permission = storedKey.permission.FunctionCall;
    if (permission.receiver_id !== contractId) {
      throw new Error("E2E server operator key must target the deployed contract");
    }
    if (
      permission.method_names.length !== payoutMethods.length ||
      !permission.method_names.includes("credit_reward") ||
      !permission.method_names.includes("pay_job") ||
      payoutMethods.some((method) => !permission.method_names.includes(method))
    ) {
      throw new Error("E2E server operator key method allowlist is not credit_reward,pay_job");
    }
    if (!permission.allowance || BigInt(permission.allowance) !== yocto(5)) {
      throw new Error("E2E server operator key allowance does not match policy");
    }

    const restrictedKeyStore = new keyStores.InMemoryKeyStore();
    await restrictedKeyStore.setKey("testnet", operator.accountId, operatorSigner);
    const restrictedNear = await connect({
      networkId: "testnet",
      nodeUrl: worker.provider.connection.url,
      keyStore: restrictedKeyStore,
      deps: { keyStore: restrictedKeyStore },
    });
    const restrictedOperator = await restrictedNear.account(operator.accountId);

    const alice = await root.createSubAccount("alice", { initialBalance: yocto(20) });
    const bob = await root.createSubAccount("bob", { initialBalance: yocto(20) });

    await callTx(operator, contractId, "create_wallet", {
      wallet: "npc:professor-kofi",
      initial_balance: "10000",
    });
    await callTx(operator, contractId, "create_wallet", {
      wallet: "gov:council",
      initial_balance: "0",
    });
    await callTx(operator, contractId, "create_property", {
      kind: "plot",
      district: "knowledge",
      x: options.city ? 4 : 1,
      y: options.city ? 7 : 1,
      owner_wallet: "gov:council",
      price: "300",
    });

    const databaseUrl = databaseUrlWithSchema(baseUrl, schema);
    Object.assign(process.env, {
      APP_ENV: "test",
      AUTO_TESTNET_WALLETS: options.managed ? "1" : "0",
      TESTNET_WALLET_ENCRYPTION_KEY: options.managed ? randomBytes(32).toString("base64") : "",
      TESTNET_WALLET_ACCOUNT_SUFFIX: options.managed ? root.accountId : "testnet",
      DEMO_MODE: "0",
      DATABASE_URL: databaseUrl,
      PGSSL: "disable",
      HOST: "127.0.0.1",
      PORT: "8787",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      NEAR_NETWORK: "testnet",
      NEAR_RPC_URL: worker.provider.connection.url,
      NEAR_CONTRACT_ID: contractId,
      NEAR_OPERATOR_ACCOUNT: operator.accountId,
      NEAR_OPERATOR_PRIVATE_KEY: operatorSigner.toString(),
      CHAIN_SOURCE_REQUIRED: "0",
      NPC_TICK_MS: "600000",
    });

    // Import the database singleton only after the E2E environment exists and
    // remember its closer. Startup failures before this point must not import
    // runtime configuration merely for cleanup.
    const { closeDb } = await import("../../src/db.js");
    closeApplicationDb = closeDb;
    const { buildApp } = await import("../../src/app.js");
    const cfg = makeTestConfig({
      autoTestnetWallets: !!options.managed,
      testnetWalletEncryptionKey: options.managed ? process.env.TESTNET_WALLET_ENCRYPTION_KEY! : null,
      testnetWalletAccountSuffix: options.managed ? root.accountId : "testnet",
      databaseUrl,
      rpcUrl: worker.provider.connection.url,
      contractId,
      operatorAccount: operator.accountId,
      operatorPrivateKey: operatorSigner.toString(),
      webOrigin: "http://127.0.0.1:5173",
      chainEventSourceUrl: null,
      chainSourceRequired: false,
      npcTickMs: 600_000,
    });
    const { createManagedWalletChain } = await import("../../src/managed-wallet-chain.js");
    const managedChain = options.managed ? createManagedWalletChain(cfg) : undefined;
    if (managedChain)
      managedChain.createAccount = async (accountId, publicKey) => {
        const result = await root
          .batch(accountId)
          .createAccount()
          .transfer(yocto(2))
          .addKey(publicKey)
          .transact();
        if (!result.succeeded) throw Error("Sandbox sponsor could not create the account");
        await worker.provider.fastForward(5);
      };
    app = await buildApp(cfg, { managedWalletChain: managedChain });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;

    db = postgres(databaseUrl, { max: 2, ssl: false, onnotice: () => {} });
    await db`select 1`;

    const login = async (account: NearAccount) => {
      const keyPair = (await account.getKey())!;
      const nonceResponse = await fetch(`${base}/v1/auth/nonce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId }),
      });
      if (!nonceResponse.ok) throw new Error(`nonce failed: ${await nonceResponse.text()}`);
      const nonce = (await nonceResponse.json()) as {
        nonce: string;
        message: string;
        recipient: string;
        callbackUrl: string;
      };
      const bytes = Buffer.from(nonce.nonce, "base64");
      const digest = nep413Digest({
        message: nonce.message,
        nonce: bytes,
        recipient: nonce.recipient,
        callbackUrl: nonce.callbackUrl,
      });
      const signature = Buffer.from(keyPair.sign(digest).signature).toString("base64");
      const verify = await fetch(`${base}/v1/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: account.accountId,
          publicKey: keyPair.getPublicKey().toString(),
          signature,
          nonce: nonce.nonce,
        }),
      });
      if (!verify.ok) throw new Error(`verify failed: ${await verify.text()}`);
      const cookieHeader = verify.headers.getSetCookie?.()[0] ?? verify.headers.get("set-cookie") ?? "";
      const cookie = `${SESSION_COOKIE}=${cookieHeader.split(";")[0].split("=")[1]}`;
      const body = (await verify.json()) as { csrfToken: string };
      return { cookie, csrf: body.csrfToken };
    };

    return {
      worker,
      cfg,
      managedChain,
      contractId,
      contract,
      operator,
      operatorSigner,
      alice,
      bob,
      app,
      base,
      db,
      admin,
      schema,
      login,
      contractCall: (account: NearAccount, method: string, args: Record<string, unknown> = {}) =>
        callTx(account, contractId, method, args),
      readContract: <T>(method: string, args: Record<string, unknown> = {}) =>
        contract.call(contractId, method, args) as Promise<T>,
      restrictedFunctionCall: (method: string, args: Record<string, unknown> = {}) =>
        restrictedOperator.functionCall({
          contractId,
          methodName: method,
          args,
          gas: 30_000_000_000_000n,
          attachedDeposit: 0n,
        }),
      async stop() {
        await cleanup();
      },
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "E2E startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export type ApiResult = {
  status: number;
  body: any;
  headers: Headers;
};

export async function api(
  stack: Pick<Stack, "base">,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    csrf?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  const response = await fetch(`${stack.base}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}
