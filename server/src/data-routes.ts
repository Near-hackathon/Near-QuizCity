import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { pingDb, sql } from "./db.js";
import { viewContract, type ContractStats } from "./near.js";
import { registerRoutes } from "./routes.js";
import { syncEconomy } from "./sync.js";

export function registerDataRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get("/health", async () => {
    const db = await pingDb();
    return { ok: db, service: "quiz-city-server", contract: cfg.contractId };
  });

  app.get("/players", async () => {
    return sql`select account_id, username, reputation, created_at from players order by created_at desc limit 50`;
  });

  app.get("/wallets", async () => {
    return sql`select wallet_id, owner_type, balance, updated_at, last_tx_hash from wallets order by wallet_id`;
  });

  app.get("/transactions", async () => {
    return sql`select seq, network_id, contract_id, tx_hash, receipt_id, event_index,
                       event_name, event_version, kind, wallet_from, wallet_to, amount,
                       reference, entity_type, entity_id, block_height, block_hash,
                       chain_timestamp, payload, observed_at, created_at
                from transactions order by seq desc limit 50`;
  });

  app.get("/properties", async () => {
    return sql`select id, district, x, y, owner_wallet, property_type, price, for_sale, transfer_count
               from properties order by id`;
  });

  app.get("/businesses", async () => {
    return sql`select id, name, owner_account, property_id, treasury_wallet, revenue_total, status
               from businesses order by id`;
  });

  app.get("/economy", async () => {
    const [wallets] = await sql<{ total: string }[]>`
      select coalesce(sum(balance), 0)::text as total from wallets
    `;
    const [counts] = await sql`
      select
        (select count(*)::int from players) as players,
        (select count(*)::int from properties) as properties,
        (select count(*)::int from businesses) as businesses,
        (select count(*)::int from transactions) as transactions
    `;
    return { circulating_qc: wallets.total, ...counts };
  });

  app.get("/contract/stats", async () => viewContract<ContractStats>("get_stats"));

  app.post("/sync", async () => syncEconomy());

  registerRoutes(app);

  app.get("/snapshots", async () => {
    return sql`select taken_at, total_issued, total_burned, tx_count, players, properties, businesses
               from economy_snapshots order by id desc limit 20`;
  });
}
