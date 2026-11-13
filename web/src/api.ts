const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
const CSRF_KEY = "quizcity.csrf";

export type Property = {
  id: number;
  district: string;
  x: number;
  y: number;
  owner_wallet: string;
  property_type: string;
  price: string;
  for_sale: boolean;
  transfer_count: number;
};

export type Wallet = {
  wallet_id: string;
  owner_type: string;
  balance: string;
  updated_at: string;
};

export type Tx = {
  seq: number;
  tx_hash: string | null;
  wallet_from: string | null;
  wallet_to: string | null;
  amount: string;
  kind: string;
  event_name?: string;
  reference: string | null;
  created_at: string;
};

export type Economy = {
  circulating_qc: string;
  mirrored_wallet_sum: string;
  supply_difference: string;
  players: number;
  properties: number;
  businesses: number;
  transactions: number;
};

export type Job = {
  id: string;
  employer_wallet: string;
  employee_account: string | null;
  title: string;
  description: string;
  payment: string;
  status:
    | "open"
    | "accepted"
    | "submitted"
    | "verified"
    | "payment_pending"
    | "payment_unknown"
    | "paid"
    | "payment_failed"
    | "cancelled";
  chain_tx: string | null;
};

export type Business = {
  id: number;
  name: string;
  owner_account: string;
  property_id: number;
  treasury_wallet: string;
  revenue_total: string;
  status: string;
};

export type Question = {
  id: string;
  question: string;
  options: string[];
  category: string;
};

export type Attempt = {
  attemptId: string;
  quizId: string;
  questions: Question[];
};

export type QuizResult = {
  score: number;
  total: number;
  reward: string;
  txHash: string | null;
  alreadySubmitted: boolean;
  status?: string;
};

export type DemoAccount = {
  accountId: string;
  publicKey: string;
  secretKey: string;
};

export type ServerConfig = {
  demoMode: boolean;
  networkId: string;
  contractId: string;
};

export type DemoAccounts = {
  networkId: string;
  contractId: string;
  accounts: DemoAccount[];
};

export type AuthMe = {
  accountId: string;
  roles: string[];
  expiresAt: string;
};

export type AuthNonce = {
  accountId: string;
  nonce: string;
  message: string;
  expiresAt: string;
  domain: string;
  networkId: string;
  recipient: string;
  callbackUrl: string;
};

export type AuthVerify = AuthMe & { csrfToken: string };

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ApiRequestOptions = {
  signal?: AbortSignal;
};

function pageQuery(options: { cursor?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor !== undefined && options.cursor !== null) params.set("cursor", options.cursor);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function csrfToken(): string | null {
  try {
    return localStorage.getItem(CSRF_KEY);
  } catch {
    return null;
  }
}

function storeCsrf(token: string): void {
  try {
    localStorage.setItem(CSRF_KEY, token);
  } catch {
    // localStorage can be unavailable in some embedded contexts
  }
}

async function request<T>(path: string, init: RequestInit, options: ApiRequestOptions = {}): Promise<T> {
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
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      // keep status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return request<T>(path, { method: "GET" }, options);
}

async function post<T>(path: string, body: unknown = {}, options: ApiRequestOptions = {}): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
}

type PageOptions = ApiRequestOptions & { cursor?: string | null; limit?: number };

async function page<T>(path: string, options: PageOptions = {}): Promise<Page<T>> {
  const result = await get<Page<T>>(`${path}${pageQuery(options)}`, { signal: options.signal });
  if (
    !result ||
    !Array.isArray(result.items) ||
    !(result.nextCursor === null || typeof result.nextCursor === "string")
  ) {
    throw new Error("malformed page response");
  }
  return result;
}

export const api = {
  config: () => get<ServerConfig>("/v1/config"),
  demoAccounts: () => get<DemoAccounts>("/v1/demo/accounts"),
  authNonce: (accountId: string) => post<AuthNonce>("/v1/auth/nonce", { accountId }),
  authVerify: (input: { accountId: string; publicKey: string; signature: string; nonce: string }) =>
    post<AuthVerify>("/v1/auth/verify", input).then((result) => {
      storeCsrf(result.csrfToken);
      return result;
    }),
  authMe: () => get<AuthMe>("/v1/auth/me"),
  authLogout: () => post<{ ok: boolean }>("/v1/auth/logout", {}),
  register: (username: string, txHash: string) =>
    post<{ username: string; starter_claimed: boolean }>("/v1/players/register", { username, txHash }),
  claim: (txHash: string) => post<{ balance: string }>("/v1/players/claim", { txHash }),
  player: (accountId: string) =>
    get<{ account_id: string; username: string; wallet: { balance: string } | null }>(
      `/v1/players/${accountId}`,
    ),
  propertyPage: (options: PageOptions = {}) => page<Property>("/v1/properties", options),
  walletPage: (options: PageOptions = {}) => page<Wallet>("/v1/wallets", options),
  transactionPage: (options: PageOptions = {}) => page<Tx>("/v1/transactions", options),
  jobPage: (options: PageOptions = {}) => page<Job>("/v1/jobs", options),
  businessPage: (options: PageOptions = {}) => page<Business>("/v1/businesses", options),
  properties: (options: ApiRequestOptions = {}) =>
    page<Property>("/v1/properties", options).then((result) => result.items),
  wallets: (options: ApiRequestOptions = {}) =>
    page<Wallet>("/v1/wallets", options).then((result) => result.items),
  transactions: (options: ApiRequestOptions = {}) =>
    page<Tx>("/v1/transactions", options).then((result) => result.items),
  economy: (options: ApiRequestOptions = {}) => get<Economy>("/v1/economy", options),
  jobs: (options: ApiRequestOptions = {}) => page<Job>("/v1/jobs", options).then((result) => result.items),
  businesses: (options: ApiRequestOptions = {}) =>
    page<Business>("/v1/businesses", options).then((result) => result.items),
  acceptJob: (id: string) => post<Job>(`/v1/jobs/${id}/accept`, {}),
  submitJob: (id: string, deliverable: string) => post<Job>(`/v1/jobs/${id}/submit`, { deliverable }),
  verifyJob: (id: string, notes?: string) => post<Job>(`/v1/jobs/${id}/verify`, { notes }),
  retryJobPayment: (id: string) => post<{ job: Job }>(`/v1/jobs/${id}/retry-payment`, {}),
  completeJob: (id: string) =>
    post<{ job: Job; txHash: string; balance: string }>(`/v1/jobs/${id}/complete`, {}),
  startQuiz: (id: string) => post<Attempt>(`/v1/quizzes/${id}/start`, {}),
  submitQuiz: (id: string, attemptId: string, answers: Record<string, number>) =>
    post<QuizResult>(`/v1/quizzes/${id}/submit`, { attemptId, answers }),
  buyProperty: (id: number, txHash: string) =>
    post<{ property: Property; price: string; seller: string }>(`/v1/properties/${id}/buy`, {
      txHash,
    }),
  createBusiness: (propertyId: number, name: string, txHash: string) =>
    post<Business>("/v1/businesses", { propertyId, name, txHash }),
  payService: (businessId: number, amount: string, txHash: string) =>
    post<{ business: Business; amount: string }>(`/v1/businesses/${businessId}/pay`, {
      amount,
      txHash,
    }),
  transferBusiness: (businessId: number, newOwner: string, txHash: string) =>
    post<{ business: Business }>(`/v1/businesses/${businessId}/transfer`, { newOwner, txHash }),
};
