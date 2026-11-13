import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { differenceQc, subtractQc } from "./amount.js";
import { pageParams, pageResult, PageQuery } from "./cursor.js";
import { sql } from "./db.js";
import { viewContract, type ContractStats } from "./near.js";
import { registerRoutes } from "./routes.js";
import {
  BusinessesPage,
  ContractStatsResponse,
  SyncResponse,
  EconomyResponse,
  EmptyBody,
  ErrorResponses,
  NpcsPage,
  PlayersPage,
  PropertiesPage,
  SnapshotsPage,
  TransactionsPage,
  WalletsPage,
  WorldBootstrap,
} from "./schemas/index.js";
import { syncEconomy } from "./sync.js";
import { requireAuth, requireRole } from "./auth/plugin.js";
import { buildWorldBootstrap } from "./world-bootstrap.js";

export function registerDataRoutes(app: FastifyInstance, dependencies: { db?: Sql } = {}): void {
  const worldDb = dependencies.db ?? sql;
  app.get<{ Querystring: { sceneId?: string } }>(
    "/world/bootstrap",
    {
      schema: {
        querystring: Type.Object(
          { sceneId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" }) },
          { additionalProperties: false },
        ),
        response: { 200: WorldBootstrap, ...ErrorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return buildWorldBootstrap(worldDb, auth.accountId, request.query.sceneId!, {
        sessionId: auth.sessionTokenHash,
      });
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/players",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: PlayersPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ account_id: string }[]>`
        select account_id, username, reputation, created_at from players
        where (${cursor}::text is null or account_id > ${cursor})
        order by account_id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => row.account_id);
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/wallets",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: WalletsPage, ...ErrorResponses },
      },
    },
    async (request) => {
      requireRole(request, ["operator", "admin"]);
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ wallet_id: string }[]>`
        select wallet_id, owner_type, balance, updated_at, last_tx_hash, active
        from wallets
        where (${cursor}::text is null or wallet_id > ${cursor})
        order by wallet_id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => row.wallet_id);
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/transactions",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: TransactionsPage, ...ErrorResponses },
      },
    },
    async (request) => {
      requireRole(request, ["operator", "admin"]);
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ seq: string }[]>`
        select seq, network_id, contract_id, tx_hash, receipt_id, event_index,
               event_name, event_version, kind, wallet_from, wallet_to, amount,
               reference, entity_type, entity_id, block_height, block_hash,
               chain_timestamp, payload, observed_at, created_at
        from transactions
        where (${cursor}::bigint is null or seq < ${cursor}::bigint)
        order by seq desc limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => String(row.seq));
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/properties",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: PropertiesPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ id: string }[]>`
        select id, district, x, y, owner_wallet, property_type, price, for_sale,
               transfer_count, active
        from properties
        where (${cursor}::bigint is null or id > ${cursor}::bigint)
        order by id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => String(row.id));
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/businesses",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: BusinessesPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ id: string }[]>`
        select id, name, owner_account, property_id, treasury_wallet, revenue_total, status, active
        from businesses
        where (${cursor}::bigint is null or id > ${cursor}::bigint)
        order by id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => String(row.id));
    },
  );

  app.get("/economy", { schema: { response: { 200: EconomyResponse, ...ErrorResponses } } }, async () => {
    const [wallets] = await sql<{ total: string }[]>`
        select coalesce(sum(balance), 0)::text as total from wallets where active = true
      `;
    const [counts] = await sql`
        select
          (select count(*)::int from players) as players,
          (select count(*)::int from properties where active = true) as properties,
          (select count(*)::int from businesses where active = true) as businesses,
          (select count(*)::int from transactions) as transactions
      `;
    const stats = await viewContract<ContractStats>("get_stats");
    const canonicalSupply = subtractQc(stats.total_issued, stats.total_burned);
    return {
      circulating_qc: canonicalSupply,
      mirrored_wallet_sum: wallets.total,
      supply_difference: differenceQc(canonicalSupply, wallets.total),
      ...counts,
    };
  });

  app.get(
    "/contract/stats",
    { schema: { response: { 200: ContractStatsResponse, ...ErrorResponses } } },
    async () => viewContract<ContractStats>("get_stats"),
  );

  app.post(
    "/sync",
    {
      schema: {
        body: EmptyBody,
        response: { 200: SyncResponse, ...ErrorResponses },
      },
    },
    async (request) => {
      requireRole(request, ["operator", "admin"]);
      return syncEconomy();
    },
  );

  registerRoutes(app);

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/snapshots",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: SnapshotsPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ id: string }[]>`
        select id, taken_at, total_issued, total_burned, tx_count, players,
               properties, businesses, fingerprint
        from economy_snapshots
        where (${cursor}::bigint is null or id > ${cursor}::bigint)
        order by id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => String(row.id));
    },
  );

  app.get<{ Querystring: Static<typeof PageQuery> }>(
    "/npcs",
    {
      schema: {
        querystring: PageQuery,
        response: { 200: NpcsPage, ...ErrorResponses },
      },
    },
    async (request) => {
      const { limit, cursor } = pageParams(request.query);
      const rows = await sql<{ npc_id: string }[]>`
        select n.npc_id, n.wallet_id, n.archetype, n.budget, n.state, n.last_tick_at,
               coalesce(w.balance, 0)::text as chain_balance
        from npc_state n
        left join wallets w on w.wallet_id = n.wallet_id
        where (${cursor}::text is null or n.npc_id > ${cursor})
        order by n.npc_id limit ${limit + 1}
      `;
      return pageResult([...rows], limit, (row) => row.npc_id);
    },
  );
}
