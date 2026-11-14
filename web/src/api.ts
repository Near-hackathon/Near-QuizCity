import { PublicMatchesResponse, MatchResponse, MatchesResponse, QuizMatch } from "@quiz-city/protocol";
import { forgetManagedProof } from "./wallet/managed-intents";
import { browserApiBase } from "./api-base";
import {
  CityOverview,
  CityHealth,
  CityOperationResponse,
  CityRow,
  type CityCommandType,
  type QuizDraftInput,
} from "@quiz-city/protocol";
const API = browserApiBase();
const CSRF_KEY = "quizcity.csrf";

import type { Static, TSchema } from "@sinclair/typebox";
import {
  CommerceCapabilities,
  WithdrawResponse,
  CatalogueResponse,
  ShopItem,
  OrdersResponse,
  OrderResponse,
  ResearchTaskResponse,
  ResearchSubmitResponse,
  LinkProfileResponse,
  ProfilesResponse,
  EnterProfileResponse,
  ResidentProfile,
  ManagedWalletStatus,
  ManagedWalletSent,
  OnboardingResponse,
  BusinessResponse,
  BusinessesPage,
  BuyPropertyResponse,
  ClaimResponse,
  CompleteJobResponse,
  ConfigResponse,
  DemoAccountsResponse,
  EconomyResponse,
  JobResponse,
  JobsPage,
  MeResponse,
  NonceResponse,
  OkResponse,
  PayServiceResponse,
  PlayerResponse,
  PropertiesPage,
  QuizzesPage,
  QuizResponse,
  RegisterResponse,
  RetryJobResponse,
  StartQuizResponse,
  SubmitQuizResponse,
  TransactionsPage,
  TransferBusinessResponse,
  VerifyResponse,
  WalletsPage,
  assertProtocolCompatible,
  type BusinessItem,
  type DemoAccountItem,
  type PropertyItem,
  type SnapshotQuestionResponse,
  type TransactionItem,
  type WalletItem,
} from "@quiz-city/protocol";

export type FriendMatch = Static<typeof QuizMatch>;
export type Resident = Static<typeof ResidentProfile>;
export type Property = Static<typeof PropertyItem>;
export type Wallet = Static<typeof WalletItem>;
export type Tx = Static<typeof TransactionItem>;
export type Economy = Static<typeof EconomyResponse>;
export type Job = Static<typeof JobResponse>;
export type Business = Static<typeof BusinessItem>;
export type Question = Static<typeof SnapshotQuestionResponse>;
export type Attempt = Static<typeof StartQuizResponse>;
export type QuizResult = Static<typeof SubmitQuizResponse>;
export type Quiz = Static<typeof QuizResponse>;
export type DemoAccount = Static<typeof DemoAccountItem>;
export type ServerConfig = Static<typeof ConfigResponse>;
export type DemoAccounts = Static<typeof DemoAccountsResponse>;
export type AuthMe = Static<typeof MeResponse>;
export type AuthNonce = Static<typeof NonceResponse>;
export type AuthVerify = Static<typeof VerifyResponse> & { csrfToken: string };

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ApiRequestOptions = {
  signal?: AbortSignal;
};
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function pageQuery(options: { cursor?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor !== undefined && options.cursor !== null) params.set("cursor", options.cursor);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function csrfToken(): string | null {
  try {
    return sessionStorage.getItem(CSRF_KEY);
  } catch {
    return null;
  }
}

function storeCsrf(token: string): void {
  try {
    sessionStorage.setItem(CSRF_KEY, token);
  } catch {
    // sessionStorage can be unavailable in some embedded contexts
  }
}

function schemaIssue(schema: Record<string, unknown>, value: unknown, path = "response"): string | null {
  if ("const" in schema && value !== schema.const) return path;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((candidate) => !schemaIssue(candidate, value, path)) ? null : path;
  }
  if (schema.type === "null") return value === null ? null : path;
  if (schema.type === "boolean") return typeof value === "boolean" ? null : path;
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value) ? null : path;
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return path;
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) return path;
    if (typeof schema.maximum === "number" && (value as number) > schema.maximum) return path;
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return path;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return path;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return path;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return path;
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return path;
    if (
      schema.format === "qc-amount" &&
      (!/^(0|[1-9][0-9]*)$/.test(value) ||
        value.length > 39 ||
        BigInt(value) > 340282366920938463463374607431768211455n)
    ) {
      return path;
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return path;
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (!itemSchema) return null;
    for (let index = 0; index < value.length; index += 1) {
      const issue = schemaIssue(itemSchema, value[index], `${path}/${index}`);
      if (issue) return issue;
    }
    return null;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return path;
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) return `${path}/${key}`;
    }
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) {
        const issue = schemaIssue(properties[key], item, `${path}/${key}`);
        if (issue) return issue;
      } else if (schema.additionalProperties === false) {
        return `${path}/${key}`;
      }
    }
  }
  return null;
}

function parse<T extends TSchema>(schema: T, body: unknown, path: string): Static<T> {
  const issue = schemaIssue(schema as Record<string, unknown>, body);
  if (issue) throw new Error(`${path} returned a malformed response at ${issue}`);
  return body as Static<T>;
}

async function request<T extends TSchema>(
  path: string,
  init: RequestInit,
  schema: T,
  options: ApiRequestOptions = {},
): Promise<Static<T>> {
  const headers = new Headers(init.headers);
  const csrf = csrfToken();
  if (csrf) headers.set("x-csrf-token", csrf);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: "include",
    signal: options.signal,
  });
  if (!res.ok) {
    let message = `${path} failed: ${res.status}`;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
      if (typeof body?.error?.code === "string") code = body.error.code;
    } catch {
      // keep status message
    }
    throw new ApiError(message, res.status, code);
  }
  const result = parse(schema, await res.json(), path);
  if (init.method === "POST" && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      if (typeof body.txHash === "string") forgetManagedProof(body.txHash);
    } catch {
      /* no proof in this command */
    }
  }
  return result;
}

async function get<T extends TSchema>(path: string, schema: T, options: ApiRequestOptions = {}) {
  return request(path, { method: "GET" }, schema, options);
}

async function post<T extends TSchema>(
  path: string,
  body: unknown,
  schema: T,
  options: ApiRequestOptions = {},
) {
  return request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    schema,
    options,
  );
}

type PageOptions = ApiRequestOptions & { cursor?: string | null; limit?: number };

async function page<T extends TSchema>(path: string, schema: T, options: PageOptions = {}) {
  return get(`${path}${pageQuery(options)}`, schema, { signal: options.signal });
}

export const api = {
  publicQuizRooms: (query: { q?: string; stake?: string } = {}) => {
    const p = new URLSearchParams(query);
    return get(`/v1/quiz-matches/public?${p}`, PublicMatchesResponse);
  },
  findQuizOpponent: (requestId: string, stake: string) =>
    post("/v1/quiz-matches/search", { requestId, stake }, MatchResponse),
  joinPublicQuizRoom: (id: string, requestId: string) =>
    post(`/v1/quiz-matches/public/${id}/join`, { requestId }, MatchResponse),
  quizMatches: () => get("/v1/quiz-matches", MatchesResponse),
  quizMatch: (id: string) => get(`/v1/quiz-matches/${id}`, MatchResponse),
  createQuizMatch: (requestId: string, stake: string, visibility?: "private" | "public") =>
    post("/v1/quiz-matches", { requestId, stake, ...(visibility ? { visibility } : {}) }, MatchResponse),
  joinQuizMatch: (requestId: string, code: string) =>
    post("/v1/quiz-matches/join", { requestId, code }, MatchResponse),
  submitQuizMatch: (id: string, answers: Record<string, number>) =>
    post(`/v1/quiz-matches/${id}/submit`, { answers }, MatchResponse),
  cancelQuizMatch: (id: string) => post(`/v1/quiz-matches/${id}/cancel`, {}, MatchResponse),
  confirmQuizMatch: (id: string, txHash: string) =>
    post(`/v1/quiz-matches/${id}/confirm`, { txHash }, MatchResponse),
  cityOverview: () => get("/v1/city/overview", CityOverview),
  cityHealth: (diagnostics = false) =>
    get(diagnostics ? "/v1/city/diagnostics" : "/v1/city/health", CityHealth),
  cityModeration: () => get("/v1/city/moderation", CityRow),
  cityCommand: (input: CityCommandType) => post("/v1/city/commands", input, CityOperationResponse),
  cityExecute: (id: string) =>
    post(`/v1/city/operations/${encodeURIComponent(id)}/execute`, {}, CityOperationResponse),
  cityConfirm: (id: string, txHash: string) =>
    post(`/v1/city/operations/${id}/confirm`, { txHash }, CityOperationResponse),
  shopHours: (id: string, input: { openMinute: number; closeMinute: number; acceptingCustomers: boolean }) =>
    post(`/v1/city/shops/${id}/hours`, input, CityRow),
  rentOffer: (id: string, input: { rent: string; periodDays: 7 | 30; active: boolean }, txHash: string) =>
    post(`/v1/city/property/${id}/rent-offer`, { ...input, txHash }, CityRow),
  reviewWork: (id: string, decision: string, note: string, resolve = false) =>
    post(`/v1/city/jobs/${id}/${resolve ? "resolve" : "review"}`, { decision, note }, CityRow),
  createQuizDraft: (input: QuizDraftInput) => post("/v1/city/quizzes/drafts", input, CityRow),
  reviewQuizDraft: (id: string, decision: string, note: string) =>
    post(`/v1/city/quizzes/drafts/${id}/review`, { decision, note }, CityRow),
  reportQuiz: (id: string, reason: string) =>
    post(`/v1/city/quizzes/drafts/${id}/report`, { reason }, CityRow),
  resolveReport: (id: string, reason: string) => post(`/v1/city/reports/${id}/resolve`, { reason }, CityRow),
  closeQuiz: (id: string, reason: string) =>
    post(`/v1/city/quizzes/${id}/close`, { reason }, CityOperationResponse),
  setBudget: (id: string, ceiling: string) => post(`/v1/city/budgets/${id}`, { ceiling }, CityRow),
  marketConfirm: (id: string, method: string, args: Record<string, unknown>, txHash: string) =>
    post(`/v1/city/market/${id}/confirm`, { method, args, txHash }, CityRow),
  config: async () => {
    const config = await get("/v1/config", ConfigResponse);
    assertProtocolCompatible(config.protocolVersion);
    return config;
  },
  demoAccounts: () => get("/v1/demo/accounts", DemoAccountsResponse),
  authNonce: (accountId: string) => post("/v1/auth/nonce", { accountId }, NonceResponse),
  authVerify: (input: { accountId: string; publicKey: string; signature: string; nonce: string }) =>
    post("/v1/auth/verify", input, VerifyResponse).then((result) => {
      storeCsrf(result.csrfToken);
      return result;
    }),
  linkProfileWallet: (profileId?: string) =>
    post("/v1/profiles/link-wallet", profileId ? { profileId } : {}, LinkProfileResponse),
  managedWalletStatus: (id: string, options: ApiRequestOptions = {}) =>
    get(`/v1/profiles/${encodeURIComponent(id)}/wallet`, ManagedWalletStatus, options),
  retryManagedWallet: (id: string) =>
    post(`/v1/profiles/${encodeURIComponent(id)}/wallet/retry`, {}, ManagedWalletStatus),
  managedTransaction: (input: { requestId: string; method: string; args: Record<string, unknown> }) =>
    post("/v1/wallet/transactions", input, ManagedWalletSent),
  downloadManagedBackup: async (id: string) => {
    const res = await fetch(`${API}/v1/profiles/${encodeURIComponent(id)}/wallet/backup`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken() ?? "" },
      body: JSON.stringify({ confirm: true }),
    });
    if (!res.ok)
      throw new ApiError("The wallet backup could not be downloaded. Sign in again and retry.", res.status);
    return res.blob();
  },
  prepareProfileDevice: () => post("/v1/profiles/device", {}, OkResponse),
  profiles: () => get("/v1/profiles", ProfilesResponse),
  createProfile: (username: string, firstName: string) =>
    post("/v1/profiles", { username, firstName }, EnterProfileResponse).then((result) => {
      storeCsrf(result.csrfToken);
      return result;
    }),
  enterProfile: (id: string) =>
    post("/v1/profiles/enter", { id }, EnterProfileResponse).then((result) => {
      storeCsrf(result.csrfToken);
      return result;
    }),
  finishOnboarding: (answers: number[]) => post("/v1/profiles/onboarding", { answers }, OnboardingResponse),
  authMe: () => get("/v1/auth/me", MeResponse),
  clearCsrf: () => {
    try {
      sessionStorage.removeItem(CSRF_KEY);
    } catch {
      // ignore unavailable storage
    }
  },
  authLogout: () => post("/v1/auth/logout", {}, OkResponse),
  register: (username: string, txHash: string) =>
    post("/v1/players/register", { username, txHash }, RegisterResponse),
  claim: (txHash: string) => post("/v1/players/claim", { txHash }, ClaimResponse),
  player: (accountId: string) => get(`/v1/players/${accountId}`, PlayerResponse),
  propertyPage: (options: PageOptions = {}) => page("/v1/properties", PropertiesPage, options),
  walletPage: (options: PageOptions = {}) => page("/v1/wallets", WalletsPage, options),
  transactionPage: (options: PageOptions = {}) => page("/v1/transactions", TransactionsPage, options),
  jobPage: (options: PageOptions = {}) => page("/v1/jobs", JobsPage, options),
  businessPage: (options: PageOptions = {}) => page("/v1/businesses", BusinessesPage, options),
  quizPage: (options: PageOptions = {}) => page("/v1/quizzes", QuizzesPage, options),
  properties: (options: ApiRequestOptions = {}) =>
    page("/v1/properties", PropertiesPage, options).then((result) => result.items),
  wallets: (options: ApiRequestOptions = {}) =>
    page("/v1/wallets", WalletsPage, options).then((result) => result.items),
  transactions: (options: ApiRequestOptions = {}) =>
    page("/v1/transactions", TransactionsPage, options).then((result) => result.items),
  economy: (options: ApiRequestOptions = {}) => get("/v1/economy", EconomyResponse, options),
  jobs: (options: ApiRequestOptions = {}) =>
    page("/v1/jobs", JobsPage, options).then((result) => result.items),
  businesses: (options: ApiRequestOptions = {}) =>
    page("/v1/businesses", BusinessesPage, options).then((result) => result.items),
  quizzes: (options: ApiRequestOptions = {}) =>
    page("/v1/quizzes", QuizzesPage, options).then((result) => result.items),
  commerceCapabilities: () => get("/v1/commerce/capabilities", CommerceCapabilities),
  withdrawBusiness: (id: string, amount: string, txHash: string) =>
    post(`/v1/businesses/${id}/withdraw`, { amount, txHash }, WithdrawResponse),
  catalogue: (id: string) => get(`/v1/businesses/${id}/catalogue`, CatalogueResponse),
  createItem: (id: string, input: { sku: string; name: string; unitPrice: string; quantity: number }) =>
    post(`/v1/businesses/${id}/catalogue`, input, ShopItem),
  myOrders: () => get("/v1/orders", OrdersResponse),
  reserveOrder: (itemId: string, quantity: number) => post("/v1/orders", { itemId, quantity }, OrderResponse),
  confirmOrder: (id: string, txHash: string) => post(`/v1/orders/${id}/confirm`, { txHash }, OrderResponse),
  deliverStock: (id: string, quantity: number, reference: string) =>
    post(`/v1/items/${id}/deliveries`, { quantity, reference }, ShopItem),
  itemSettings: (id: string, unitPrice: string, active: boolean) =>
    post(`/v1/items/${id}/settings`, { unitPrice, active }, ShopItem),
  researchTask: (id: string) => get(`/v1/jobs/${id}/task`, ResearchTaskResponse),
  submitResearch: (id: string, answers: Record<string, number>, summary: string) =>
    post(`/v1/jobs/${id}/task`, { answers, summary }, ResearchSubmitResponse),
  acceptJob: (id: string) => post(`/v1/jobs/${id}/accept`, {}, JobResponse),
  submitJob: (id: string, deliverable: string) => post(`/v1/jobs/${id}/submit`, { deliverable }, JobResponse),
  verifyJob: (id: string, notes?: string) => post(`/v1/jobs/${id}/verify`, { notes }, JobResponse),
  retryJobPayment: (id: string) => post(`/v1/jobs/${id}/retry-payment`, {}, RetryJobResponse),
  completeJob: (id: string) => post(`/v1/jobs/${id}/complete`, {}, CompleteJobResponse),
  startQuiz: (id: string) => post(`/v1/quizzes/${id}/start`, {}, StartQuizResponse),
  submitQuiz: (id: string, attemptId: string, answers: Record<string, number>) =>
    post(`/v1/quizzes/${id}/submit`, { attemptId, answers }, SubmitQuizResponse),
  buyProperty: (id: string | number, txHash: string) =>
    post(`/v1/properties/${id}/buy`, { txHash }, BuyPropertyResponse),
  createBusiness: (propertyId: string | number, name: string, txHash: string) =>
    post("/v1/businesses", { propertyId: Number(propertyId), name, txHash }, BusinessResponse),
  payService: (businessId: string | number, amount: string, txHash: string) =>
    post(`/v1/businesses/${businessId}/pay`, { amount, txHash }, PayServiceResponse),
  transferBusiness: (businessId: string | number, newOwner: string, txHash: string) =>
    post(`/v1/businesses/${businessId}/transfer`, { newOwner, txHash }, TransferBusinessResponse),
};
