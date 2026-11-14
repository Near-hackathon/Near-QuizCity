import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { Type, type Static } from "@sinclair/typebox";
import { ManagedWalletStatus, ManagedWalletRequest, ManagedWalletSent } from "@quiz-city/protocol";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { requireAuth } from "./auth/plugin.js";
import { ErrorResponses } from "./schemas/index.js";
import {
  assertOwnedManagedProfile,
  getManagedWallet,
  managedWalletStatus,
  requireManagedWallets,
  signManagedTransaction,
  assertManagedIntent,
} from "./managed-wallets.js";
import { openWalletKey, walletContext } from "./wallet-vault.js";
import { createManagedWalletChain, type ManagedWalletChain } from "./managed-wallet-chain.js";
export const profileDeviceToken = (header?: string) =>
  header
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("qc_device="))
    ?.slice(10) ?? null;
const params = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
export function registerManagedWalletRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  resolveDb: () => Promise<Sql>,
  injected?: ManagedWalletChain,
) {
  let chain: ManagedWalletChain | undefined = injected;
  const origin = (value?: string) => {
    if (value !== cfg.webOrigin) throw new AppError("FORBIDDEN", "Open the game from its own website.", 403);
  };
  app.get<{ Params: { id: string } }>(
    "/v1/profiles/:id/wallet",
    { schema: { params, response: { 200: ManagedWalletStatus, ...ErrorResponses } } },
    async (req, reply) => {
      const sql = await resolveDb();
      await assertOwnedManagedProfile(sql, req.params.id, profileDeviceToken(req.headers.cookie));
      reply.header("cache-control", "no-store");
      return managedWalletStatus(await getManagedWallet(sql, req.params.id), cfg.autoTestnetWallets);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/profiles/:id/wallet/retry",
    {
      schema: {
        params,
        body: Type.Object({}, { additionalProperties: false }),
        response: { 200: ManagedWalletStatus, ...ErrorResponses },
      },
    },
    async (req) => {
      requireManagedWallets(cfg);
      origin(req.headers.origin);
      const sql = await resolveDb();
      await assertOwnedManagedProfile(sql, req.params.id, profileDeviceToken(req.headers.cookie));
      await sql`update managed_wallets set next_attempt_at=now() where profile_id=${req.params.id} and stage<>'ready' and last_error_code is not null and next_attempt_at>now()+interval '30 seconds'`;
      return managedWalletStatus(await getManagedWallet(sql, req.params.id), true);
    },
  );
  app.post<{ Params: { id: string }; Body: { confirm: boolean } }>(
    "/v1/profiles/:id/wallet/backup",
    {
      schema: {
        params,
        body: Type.Object({ confirm: Type.Literal(true) }, { additionalProperties: false }),
        response: { 200: Type.String(), ...ErrorResponses },
      },
    },
    async (req, reply) => {
      requireManagedWallets(cfg);
      origin(req.headers.origin);
      const sql = await resolveDb(),
        actor = requireAuth(req);
      const profile = await assertOwnedManagedProfile(
        sql,
        req.params.id,
        profileDeviceToken(req.headers.cookie),
      );
      if (actor.accountId !== profile.account_id)
        throw new AppError("FORBIDDEN", "Sign in as this resident before downloading its backup.", 403);
      const w = await getManagedWallet(sql, profile.id);
      if (!w || w.stage === "creating_account")
        throw new AppError(
          "CONFLICT",
          "Wait until the account has been confirmed before exporting its backup.",
          409,
        );
      const secret = openWalletKey(
        cfg.testnetWalletEncryptionKey!,
        w.encrypted_key,
        walletContext(w.profile_id, w.account_id),
      );
      await sql`insert into managed_wallet_audit(profile_id,action) values(${profile.id},'backup_exported')`;
      reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .header("content-disposition", `attachment; filename="${w.account_id}.json"`)
        .type("application/octet-stream");
      return reply.send(
        Buffer.from(
          JSON.stringify(
            { account_id: w.account_id, public_key: w.public_key, private_key: secret },
            null,
            2,
          ),
        ),
      );
    },
  );
  app.post<{ Body: Static<typeof ManagedWalletRequest> }>(
    "/v1/wallet/transactions",
    { schema: { body: ManagedWalletRequest, response: { 200: ManagedWalletSent, ...ErrorResponses } } },
    async (req) => {
      requireManagedWallets(cfg);
      origin(req.headers.origin);
      const sql = await resolveDb(),
        actor = requireAuth(req);
      const [p] = await sql<
        { id: string }[]
      >`select id from resident_profiles where account_id=${actor.accountId} and wallet_kind='embedded'`;
      if (!p) throw new AppError("NOT_FOUND", "Managed wallet not found.", 404);
      await assertOwnedManagedProfile(sql, p.id, profileDeviceToken(req.headers.cookie));
      const w = await getManagedWallet(sql, p.id);
      if (w?.stage !== "ready")
        throw new AppError("CONFLICT", "Finish the saved account setup before spending QC.", 409);
      const [savedRequest] =
        await sql`select id from managed_wallet_transactions where id=${req.body.requestId} and profile_id=${p.id}`;
      // An existing request is bound again below to the exact account/arguments.
      // Its quote can already be applied when the prior HTTP response was lost.
      if (!savedRequest) await assertManagedIntent(sql, actor.accountId, req.body.method, req.body.args);
      chain ??= createManagedWalletChain(cfg);
      const tx = await signManagedTransaction(
        sql,
        cfg,
        chain,
        p.id,
        req.body.requestId,
        req.body.method,
        req.body.args,
      );
      return { txHash: tx.tx_hash, state: tx.state };
    },
  );
}
