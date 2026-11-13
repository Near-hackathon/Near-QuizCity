import { Type } from "@sinclair/typebox";
import { QcAmount } from "./common.js";

const NullableString = Type.Union([Type.String(), Type.Null()]);
const JsonObject = Type.Object({}, { additionalProperties: true });

export const HealthCheckStatus = Type.Union([
  Type.Literal("ok"),
  Type.Literal("failed"),
  Type.Literal("disabled"),
]);

export const HealthResponse = Type.Object(
  {
    ok: Type.Boolean(),
    service: Type.String(),
    contract: Type.String(),
    checks: Type.Optional(
      Type.Object(
        {
          database: HealthCheckStatus,
          contract: HealthCheckStatus,
          indexer: HealthCheckStatus,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ConfigResponse = Type.Object(
  {
    demoMode: Type.Boolean(),
    networkId: Type.String(),
    contractId: Type.String(),
  },
  { additionalProperties: false },
);

export const PlayerItem = Type.Object(
  {
    account_id: Type.String(),
    username: Type.String(),
    reputation: Type.Integer(),
    created_at: Type.String(),
  },
  { additionalProperties: false },
);

export const WalletItem = Type.Object(
  {
    wallet_id: Type.String(),
    owner_type: Type.String(),
    balance: QcAmount,
    updated_at: Type.String(),
    last_tx_hash: NullableString,
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TransactionItem = Type.Object(
  {
    seq: Type.String(),
    network_id: Type.String(),
    contract_id: Type.String(),
    tx_hash: NullableString,
    receipt_id: Type.String(),
    event_index: Type.Integer(),
    event_name: Type.String(),
    event_version: Type.String(),
    kind: Type.String(),
    wallet_from: NullableString,
    wallet_to: NullableString,
    amount: QcAmount,
    reference: NullableString,
    entity_type: NullableString,
    entity_id: NullableString,
    block_height: NullableString,
    block_hash: NullableString,
    chain_timestamp: NullableString,
    payload: JsonObject,
    observed_at: Type.String(),
    created_at: Type.String(),
  },
  { additionalProperties: false },
);

export const PropertyItem = Type.Object(
  {
    id: Type.String(),
    district: Type.String(),
    x: Type.Integer(),
    y: Type.Integer(),
    owner_wallet: Type.String(),
    property_type: Type.String(),
    price: QcAmount,
    for_sale: Type.Boolean(),
    transfer_count: Type.String(),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const BusinessItem = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    owner_account: Type.String(),
    property_id: Type.String(),
    treasury_wallet: Type.String(),
    revenue_total: QcAmount,
    status: Type.String(),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SnapshotItem = Type.Object(
  {
    id: Type.String(),
    taken_at: Type.String(),
    total_issued: QcAmount,
    total_burned: QcAmount,
    tx_count: Type.String(),
    players: Type.Integer(),
    properties: Type.Integer(),
    businesses: Type.Integer(),
    fingerprint: NullableString,
  },
  { additionalProperties: false },
);

export const NpcItem = Type.Object(
  {
    npc_id: Type.String(),
    wallet_id: Type.String(),
    archetype: Type.String(),
    budget: QcAmount,
    state: JsonObject,
    last_tick_at: NullableString,
    chain_balance: QcAmount,
  },
  { additionalProperties: false },
);

function pageOf<T extends ReturnType<typeof Type.Object>>(item: T) {
  return Type.Object(
    { items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) },
    { additionalProperties: false },
  );
}

export const PlayersPage = pageOf(PlayerItem);
export const WalletsPage = pageOf(WalletItem);
export const TransactionsPage = pageOf(TransactionItem);
export const PropertiesPage = pageOf(PropertyItem);
export const BusinessesPage = pageOf(BusinessItem);
export const SnapshotsPage = pageOf(SnapshotItem);
export const NpcsPage = pageOf(NpcItem);

export const EconomyResponse = Type.Object(
  {
    circulating_qc: QcAmount,
    mirrored_wallet_sum: QcAmount,
    supply_difference: Type.String({ pattern: "^-?(0|[1-9][0-9]*)$", maxLength: 40 }),
    players: Type.Integer(),
    properties: Type.Integer(),
    businesses: Type.Integer(),
    transactions: Type.Integer(),
  },
  { additionalProperties: false },
);

export const ContractStatsResponse = Type.Object(
  {
    players: Type.Integer(),
    properties: Type.Integer(),
    businesses: Type.Integer(),
    total_issued: QcAmount,
    total_burned: QcAmount,
    tx_count: Type.Integer(),
  },
  { additionalProperties: false },
);

export const SyncResponse = Type.Object(
  {
    skipped: Type.Boolean(),
    wallets: Type.Integer(),
    properties: Type.Integer(),
    businesses: Type.Integer(),
    canonicalSupply: QcAmount,
    mirroredWalletSum: QcAmount,
    difference: Type.String({ pattern: "^-?(0|[1-9][0-9]*)$", maxLength: 40 }),
  },
  { additionalProperties: false },
);

export const DemoAccountItem = Type.Object(
  {
    accountId: Type.String(),
    publicKey: Type.String(),
    secretKey: Type.String(),
  },
  { additionalProperties: false },
);

export const DemoAccountsResponse = Type.Object(
  {
    networkId: Type.String(),
    contractId: Type.String(),
    accounts: Type.Array(DemoAccountItem),
  },
  { additionalProperties: false },
);
