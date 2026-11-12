const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

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
  wallet_from: string;
  wallet_to: string;
  amount: string;
  kind: string;
  reference: string | null;
  created_at: string;
};

export type Economy = {
  circulating_qc: string;
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
  status: "open" | "accepted" | "completed" | "paid" | "cancelled";
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
  reward: number;
  txHash: string | null;
  alreadySubmitted: boolean;
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${path} failed: ${res.status}`;
    try {
      const parsed = (await res.json()) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // keep status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => get<ServerConfig>("/config"),
  demoAccounts: () => get<DemoAccounts>("/demo/accounts"),
  register: (accountId: string, txHash: string) =>
    post<{ username: string; starter_claimed: boolean }>("/players/register", { accountId, txHash }),
  claim: (accountId: string, txHash: string) =>
    post<{ balance: string }>("/players/claim", { accountId, txHash }),
  player: (accountId: string) =>
    get<{ account_id: string; username: string; wallet: { balance: string } | null }>(
      `/players/${accountId}`,
    ),
  properties: () => get<Property[]>("/properties"),
  wallets: () => get<Wallet[]>("/wallets"),
  transactions: () => get<Tx[]>("/transactions"),
  economy: () => get<Economy>("/economy"),
  jobs: () => get<Job[]>("/jobs"),
  businesses: () => get<Business[]>("/businesses"),
  acceptJob: (id: string, accountId: string) => post<Job>(`/jobs/${id}/accept`, { accountId }),
  completeJob: (id: string, accountId: string) =>
    post<{ job: Job; txHash: string; balance: string }>(`/jobs/${id}/complete`, { accountId }),
  startQuiz: (id: string, accountId: string) => post<Attempt>(`/quizzes/${id}/start`, { accountId }),
  submitQuiz: (id: string, accountId: string, attemptId: string, answers: Record<string, number>) =>
    post<QuizResult>(`/quizzes/${id}/submit`, { accountId, attemptId, answers }),
  buyProperty: (id: number, accountId: string, txHash: string) =>
    post<{ property: Property; price: number; seller: string }>(`/properties/${id}/buy`, {
      accountId,
      txHash,
    }),
  createBusiness: (accountId: string, propertyId: number, name: string, txHash: string) =>
    post<Business>("/businesses", { accountId, propertyId, name, txHash }),
  payService: (businessId: number, accountId: string, amount: number, txHash: string) =>
    post<{ business: Business; amount: number }>(`/businesses/${businessId}/pay`, {
      accountId,
      amount,
      txHash,
    }),
  transferBusiness: (businessId: number, accountId: string, newOwner: string, txHash: string) =>
    post<{ business: Business }>(`/businesses/${businessId}/transfer`, { accountId, newOwner, txHash }),
};
