import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { QcAmount, TxHash, AccountId } from "./common.js";
const text = (min: number, max: number) => Type.String({ minLength: min, maxLength: max });
export const CityId = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export const CityCommand = Type.Object(
  {
    requestId: Type.String({ format: "uuid" }),
    action: Type.Union(
      [
        "supplier",
        "job",
        "public-job",
        "admission",
        "quiz-fund",
        "rent",
        "upkeep",
        "budget",
        "refund",
        "refund-admission",
        "cancel-order",
        "settlement",
        "sponsor",
        "tax",
        "cancel-payment",
      ].map((v) => Type.Literal(v)),
    ),
    targetId: text(1, 128),
    quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    amount: Type.Optional(QcAmount),
    title: Type.Optional(text(3, 100)),
    description: Type.Optional(text(20, 2000)),
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    category: Type.Optional(
      Type.Union(
        ["library", "employment", "quizzes", "maintenance", "suppliers"].map((v) => Type.Literal(v)),
      ),
    ),
    recipient: Type.Optional(text(1, 96)),
  },
  { additionalProperties: false },
);
export const CityOperation = Type.Object(
  {
    id: Type.String(),
    kind: Type.String(),
    method: Type.String(),
    args: Type.Record(Type.String(), Type.Unknown()),
    status: Type.String(),
    tx_hash: Type.Union([Type.String(), Type.Null()]),
    reference: Type.String(),
    actor_account: Type.String(),
  },
  { additionalProperties: true },
);
export const CityOperationResponse = Type.Object({ operation: CityOperation });
export const CityUuid = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
export const CityAssetId = Type.Object(
  { id: Type.String({ pattern: "^[1-9][0-9]{0,14}$" }) },
  { additionalProperties: false },
);
export const CityOk = Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false });
export const CityProof = Type.Object({ txHash: TxHash }, { additionalProperties: false });
export const BusinessHoursBody = Type.Object(
  {
    openMinute: Type.Integer({ minimum: 0, maximum: 1439 }),
    closeMinute: Type.Integer({ minimum: 1, maximum: 1440 }),
    acceptingCustomers: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const RentOfferBody = Type.Object(
  {
    txHash: TxHash,
    rent: QcAmount,
    periodDays: Type.Union([Type.Literal(7), Type.Literal(30)]),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const ReviewWorkBody = Type.Object(
  {
    decision: Type.Union([
      Type.Literal("approve"),
      Type.Literal("revise"),
      Type.Literal("dispute"),
      Type.Literal("cancel"),
    ]),
    note: text(10, 500),
  },
  { additionalProperties: false },
);
export const QuizDraftBody = Type.Object(
  {
    businessId: text(1, 20),
    title: text(3, 100),
    questions: Type.Array(
      Type.Object(
        {
          question: text(10, 500),
          options: Type.Array(text(1, 200), { minItems: 2, maxItems: 6 }),
          correct: Type.Integer({ minimum: 0, maximum: 5 }),
          source: Type.String({ format: "uri", maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
    passScore: Type.Integer({ minimum: 1, maximum: 20 }),
    entryFee: QcAmount,
    reward: QcAmount,
    capacity: Type.Integer({ minimum: 1, maximum: 100 }),
    opensAt: Type.String({ format: "date-time" }),
    closesAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export const QuizReviewBody = Type.Object(
  {
    decision: Type.Union([
      Type.Literal("submit"),
      Type.Literal("approve"),
      Type.Literal("reject"),
      Type.Literal("suspend"),
    ]),
    note: text(10, 500),
  },
  { additionalProperties: false },
);
export const QuizReportBody = Type.Object({ reason: text(10, 500) }, { additionalProperties: false });
export const BudgetBody = Type.Object({ ceiling: QcAmount }, { additionalProperties: false });
export const MarketProofBody = Type.Union([
  Type.Object(
    {
      method: Type.Literal("list_property"),
      args: Type.Object(
        { property_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), price: QcAmount },
        { additionalProperties: false },
      ),
      txHash: TxHash,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      method: Type.Literal("cancel_property_listing"),
      args: Type.Object(
        { property_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
        { additionalProperties: false },
      ),
      txHash: TxHash,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      method: Type.Literal("list_business"),
      args: Type.Object(
        { business_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), price: QcAmount },
        { additionalProperties: false },
      ),
      txHash: TxHash,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      method: Type.Literal("buy_business"),
      args: Type.Object(
        {
          business_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          expected_owner: AccountId,
          expected_price: QcAmount,
        },
        { additionalProperties: false },
      ),
      txHash: TxHash,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      method: Type.Literal("transfer_business"),
      args: Type.Object(
        { business_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), new_owner: AccountId },
        { additionalProperties: false },
      ),
      txHash: TxHash,
    },
    { additionalProperties: false },
  ),
]);
export const CityRow = Type.Record(Type.String(), Type.Unknown());
const nullableText = Type.Union([Type.String(), Type.Null()]);
const row = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: true });
export const SupplierRow = row({
  id: Type.String(),
  name: Type.String(),
  wallet_id: Type.String(),
  unit_price: QcAmount,
  on_hand: Type.Integer({ minimum: 0 }),
  reserved: Type.Integer({ minimum: 0 }),
  active: Type.Boolean(),
});
export const StockRow = row({
  id: Type.String(),
  business_id: Type.String(),
  name: Type.String(),
  unit_price: QcAmount,
  on_hand: Type.Integer({ minimum: 0 }),
  reserved: Type.Integer({ minimum: 0 }),
  low_stock: Type.Integer({ minimum: 0 }),
});
export const FundedWorkRow = row({
  job_id: Type.String(),
  business_id: nullableText,
  title: Type.String(),
  description: Type.String(),
  payment: QcAmount,
  state: Type.String(),
  status: nullableText,
  employee_account: nullableText,
  deliverable: nullableText,
  deadline: Type.String(),
});
export const LeaseRow = row({
  id: Type.String(),
  property_id: Type.String(),
  landlord_wallet: Type.String(),
  tenant_account: Type.String(),
  status: Type.String(),
  ends_at: nullableText,
  grace_ends_at: nullableText,
});
export const RentRow = row({
  property_id: Type.String(),
  owner_wallet: Type.String(),
  rent: QcAmount,
  period_days: Type.Integer(),
  active: Type.Boolean(),
});
export const DraftRow = row({
  id: Type.String(),
  author_account: Type.String(),
  business_id: Type.String(),
  title: Type.String(),
  questions: QuizDraftBody.properties.questions,
  pass_score: Type.Integer(),
  entry_fee: QcAmount,
  reward: QcAmount,
  capacity: Type.Integer(),
  status: Type.String(),
  opens_at: Type.String(),
  closes_at: Type.String(),
});
export const StaffRow = row({
  job_id: Type.String(),
  business_id: Type.String(),
  account_id: Type.String(),
  started_at: Type.String(),
  ended_at: nullableText,
});
export const ShopRow = row({
  id: Type.String(),
  name: Type.String(),
  owner_account: Type.String(),
  open_minute: Type.Union([Type.Integer(), Type.Null()]),
  close_minute: Type.Union([Type.Integer(), Type.Null()]),
  accepting_customers: Type.Union([Type.Boolean(), Type.Null()]),
});
export const MarketRow = row({
  id: Type.String(),
  owner_wallet: Type.String(),
  price: QcAmount,
  for_sale: Type.Boolean(),
  x: Type.Integer(),
  y: Type.Integer(),
});
export const CompanySaleRow = row({
  id: Type.String(),
  asset_id: Type.String(),
  name: Type.String(),
  owner_account: Type.String(),
  asking_price: QcAmount,
  status: Type.String(),
});
export const BudgetRow = row({
  category: Type.String(),
  ceiling: QcAmount,
  committed: QcAmount,
  spent: QcAmount,
});
export const PublicBusinessRow = row({
  id: Type.String(),
  name: Type.String(),
  owner_account: Type.String(),
  gross_revenue: QcAmount,
  treasury: QcAmount,
  expenses: QcAmount,
  customers: Type.Integer(),
  employees: Type.Integer(),
  active: Type.Boolean(),
});
export const HealthStockRow = row({
  id: Type.String(),
  business_id: Type.String(),
  name: Type.String(),
  on_hand: Type.Integer(),
  reserved: Type.Integer(),
  price: QcAmount,
  low_stock: Type.Integer(),
  units_sold: QcAmount,
});
export const PoolRow = row({
  id: Type.String(),
  title: Type.String(),
  funded: QcAmount,
  reserved: QcAmount,
  paid: QcAmount,
  available: QcAmount,
});
export const WalletGroupRow = row({ kind: Type.String(), count: Type.Integer(), balance: QcAmount });
export const JobCountRow = row({
  status: Type.String(),
  count: Type.Integer(),
  value: Type.Union([QcAmount, Type.Null()]),
});

export const PurchaseRow = row({
  id: Type.String(),
  item_name: Type.String(),
  quantity: Type.Integer(),
  total: QcAmount,
  status: Type.String(),
});
export const CustomerSaleRow = row({
  id: Type.String(),
  item_name: Type.String(),
  quantity: Type.Integer(),
  total: QcAmount,
  status: Type.String(),
  customer_wallet: Type.String(),
});
export const CityOverview = Type.Object({
  purchases: Type.Array(PurchaseRow, { maxItems: 100 }),
  sales: Type.Array(CustomerSaleRow, { maxItems: 100 }),
  operations: Type.Array(CityOperation, { maxItems: 100 }),
  admissions: Type.Array(
    row({
      operation_id: Type.String(),
      quiz_id: Type.String(),
      title: Type.String(),
      player_account: Type.String(),
      paid_at: nullableText,
      attempt_id: nullableText,
      refunded_at: nullableText,
      total: QcAmount,
      owner_account: Type.String(),
    }),
    { maxItems: 100 },
  ),
  suppliers: Type.Array(SupplierRow, { maxItems: 100 }),
  items: Type.Array(StockRow, { maxItems: 100 }),
  businessSales: Type.Array(CompanySaleRow, { maxItems: 100 }),
  jobs: Type.Array(FundedWorkRow, { maxItems: 100 }),
  leases: Type.Array(LeaseRow, { maxItems: 100 }),
  rentOffers: Type.Array(RentRow, { maxItems: 100 }),
  drafts: Type.Array(DraftRow, { maxItems: 100 }),
  staff: Type.Array(StaffRow, { maxItems: 100 }),
  shops: Type.Array(ShopRow, { maxItems: 100 }),
  market: Type.Array(MarketRow, { maxItems: 100 }),
  policy: Type.Object({ available: Type.Boolean(), dailyCap: QcAmount, issuedToday: QcAmount }),
});
export const CityHealth = Type.Object({
  propertyUse: Type.Object({
    plots: Type.Integer(),
    occupied: Type.Integer(),
    active_businesses: Type.Integer(),
    archived_businesses: Type.Integer(),
  }),
  contractStats: Type.Object({
    players: Type.Optional(Type.Integer()),
    properties: Type.Optional(Type.Integer()),
    businesses: Type.Optional(Type.Integer()),
    tx_count: Type.Optional(Type.Integer()),
    paused: Type.Optional(Type.Boolean()),
  }),
  supply: Type.Object({
    issued: QcAmount,
    burned: QcAmount,
    circulating: QcAmount,
    mirrored: QcAmount,
    difference: Type.String(),
  }),
  walletGroups: Type.Array(WalletGroupRow),
  jobs: Type.Array(JobCountRow),
  businesses: Type.Array(PublicBusinessRow),
  inventory: Type.Array(HealthStockRow),
  rewardPools: Type.Array(PoolRow),
  budgets: Type.Array(BudgetRow),
  wealth: Type.Object({ residents: Type.Integer(), gini: Type.String() }),
  alerts: Type.Array(Type.Object({ code: Type.String(), entity: Type.String(), message: Type.String() })),
  diagnostics: Type.Optional(
    Type.Object({
      properties: Type.Array(
        row({
          id: Type.String(),
          owner_wallet: Type.String(),
          price: QcAmount,
          for_sale: Type.Boolean(),
          active: Type.Boolean(),
        }),
        { maxItems: 200 },
      ),
      failures: Type.Array(CityRow, { maxItems: 100 }),
      schedules: Type.Array(CityRow, { maxItems: 200 }),
      events: Type.Array(CityRow, { maxItems: 100 }),
      wallets: Type.Array(CityRow, { maxItems: 200 }),
    }),
  ),
});
export type CityCommandType = Static<typeof CityCommand>;
export type QuizDraftInput = Static<typeof QuizDraftBody>;
export { AccountId };
