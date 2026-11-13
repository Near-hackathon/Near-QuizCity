import type { Business, Economy, Job, Property, Quiz, Tx, Wallet } from "../api";

export type EntityMaps = {
  properties: Record<string, Property>;
  businesses: Record<string, Business>;
  jobs: Record<string, Job>;
  wallets: Record<string, Wallet>;
  transactions: Record<string, Tx>;
  quizzes: Record<string, Quiz>;
};

export type EntityLists = {
  propertyIds: string[];
  businessIds: string[];
  jobIds: string[];
  walletIds: string[];
  transactionIds: string[];
  quizIds: string[];
};

export type QueryKey = keyof EntityMaps | "economy";
export type QueryMetadata = {
  nextCursor: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};

export type QueryStatus = "idle" | "loading" | "online" | "refreshing" | "offline" | "reconnecting";

export type AppState = {
  entities: EntityMaps;
  lists: EntityLists;
  economy: Economy | null;
  status: QueryStatus;
  lastSequence: number | null;
  staleScopes: string[];
  error: string | null;
  queries: Record<QueryKey, QueryMetadata>;
};

const emptyQuery = (): QueryMetadata => ({ nextCursor: null, lastSuccessAt: null, error: null });

export const initialAppState: AppState = {
  entities: { properties: {}, businesses: {}, jobs: {}, wallets: {}, transactions: {}, quizzes: {} },
  lists: {
    propertyIds: [],
    businessIds: [],
    jobIds: [],
    walletIds: [],
    transactionIds: [],
    quizIds: [],
  },
  economy: null,
  status: "idle",
  lastSequence: null,
  staleScopes: [],
  error: null,
  queries: {
    properties: emptyQuery(),
    businesses: emptyQuery(),
    jobs: emptyQuery(),
    wallets: emptyQuery(),
    transactions: emptyQuery(),
    quizzes: emptyQuery(),
    economy: emptyQuery(),
  },
};
