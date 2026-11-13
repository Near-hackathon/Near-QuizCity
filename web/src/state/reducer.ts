import type { Business, Economy, Job, Property, Quiz, Tx, Wallet } from "../api";
import { initialAppState, type AppState, type QueryStatus } from "./entities";

export type QueryName = keyof AppState["entities"] | "economy";

export type StateAction =
  | { type: "bootstrapStart"; scope: string }
  | { type: "bootstrapSuccess"; scope: string }
  | { type: "bootstrapFailure"; scope: string; message: string }
  | { type: "properties"; items: Property[] }
  | { type: "businesses"; items: Business[] }
  | { type: "jobs"; items: Job[] }
  | { type: "wallets"; items: Wallet[] }
  | { type: "transactions"; items: Tx[] }
  | { type: "quizzes"; items: Quiz[] }
  | { type: "economy"; value: Economy }
  | { type: "remove"; query: keyof AppState["entities"]; id: string }
  | { type: "invalidate"; scopes: string[] }
  | { type: "transportStatus"; status: QueryStatus }
  | { type: "sequence"; sequence: number }
  | { type: "sequenceGap"; sequence: number; scopes: string[] }
  | { type: "reset" };

const idOf = (item: { id?: string | number; wallet_id?: string; seq?: string | number }): string =>
  String(item.id ?? item.wallet_id ?? item.seq ?? "");

function upsert<T extends { id?: string | number; wallet_id?: string; seq?: string | number }>(
  map: Record<string, T>,
  currentIds: string[],
  items: T[],
  id: (item: T) => string = idOf,
): { map: Record<string, T>; ids: string[] } {
  const next = { ...map };
  for (const item of items) next[id(item)] = item;
  const ids = [...currentIds];
  for (const item of items) {
    const itemId = id(item);
    if (!ids.includes(itemId)) ids.push(itemId);
  }
  return { map: next, ids };
}

function replaceList<T extends { id?: string | number; wallet_id?: string; seq?: string | number }>(
  map: Record<string, T>,
  items: T[],
  id: (item: T) => string = idOf,
): { map: Record<string, T>; ids: string[] } {
  const next: Record<string, T> = {};
  const ids: string[] = [];
  for (const item of items) {
    const itemId = id(item);
    next[itemId] = item;
    if (!ids.includes(itemId)) ids.push(itemId);
  }
  return { map: next, ids };
}

const listKeyFor = {
  properties: "propertyIds",
  businesses: "businessIds",
  jobs: "jobIds",
  wallets: "walletIds",
  transactions: "transactionIds",
  quizzes: "quizIds",
} as const satisfies Record<keyof AppState["entities"], keyof AppState["lists"]>;

const withStatus = (state: AppState, status: QueryStatus): AppState => ({ ...state, status });

export function appReducer(state: AppState, action: StateAction): AppState {
  switch (action.type) {
    case "bootstrapStart":
      return { ...withStatus(state, state.status === "online" ? "refreshing" : "loading"), error: null };
    case "bootstrapSuccess":
      return {
        ...withStatus(state, "online"),
        error: null,
        staleScopes: state.staleScopes.filter((scope) => scope !== action.scope),
        queries:
          action.scope in state.queries
            ? {
                ...state.queries,
                [action.scope]: {
                  ...state.queries[action.scope as keyof AppState["queries"]],
                  lastSuccessAt: new Date().toISOString(),
                  error: null,
                },
              }
            : state.queries,
      };
    case "bootstrapFailure":
      return {
        ...withStatus(state, "offline"),
        error: action.message,
        queries:
          action.scope in state.queries
            ? {
                ...state.queries,
                [action.scope]: {
                  ...state.queries[action.scope as keyof AppState["queries"]],
                  error: action.message,
                },
              }
            : state.queries,
      };
    case "properties": {
      const next = replaceList(state.entities.properties, action.items);
      return {
        ...state,
        entities: { ...state.entities, properties: next.map },
        lists: { ...state.lists, propertyIds: next.ids },
      };
    }
    case "businesses": {
      const next = replaceList(state.entities.businesses, action.items);
      return {
        ...state,
        entities: { ...state.entities, businesses: next.map },
        lists: { ...state.lists, businessIds: next.ids },
      };
    }
    case "jobs": {
      const next = replaceList(state.entities.jobs, action.items);
      return {
        ...state,
        entities: { ...state.entities, jobs: next.map },
        lists: { ...state.lists, jobIds: next.ids },
      };
    }
    case "wallets": {
      const next = upsert(state.entities.wallets, state.lists.walletIds, action.items, (item) =>
        String(item.wallet_id),
      );
      return {
        ...state,
        entities: { ...state.entities, wallets: next.map },
        lists: { ...state.lists, walletIds: next.ids },
      };
    }
    case "transactions": {
      const next = upsert(state.entities.transactions, state.lists.transactionIds, action.items, (item) =>
        String(item.seq),
      );
      return {
        ...state,
        entities: { ...state.entities, transactions: next.map },
        lists: { ...state.lists, transactionIds: next.ids },
      };
    }
    case "quizzes": {
      const next = replaceList(state.entities.quizzes, action.items);
      return {
        ...state,
        entities: { ...state.entities, quizzes: next.map },
        lists: { ...state.lists, quizIds: next.ids },
      };
    }
    case "economy":
      return { ...state, economy: action.value };
    case "remove": {
      const map = { ...state.entities[action.query] };
      delete map[action.id];
      const listKey = listKeyFor[action.query];
      return {
        ...state,
        entities: { ...state.entities, [action.query]: map },
        lists: { ...state.lists, [listKey]: state.lists[listKey].filter((id) => id !== action.id) },
      };
    }
    case "invalidate":
      return { ...state, staleScopes: [...new Set([...state.staleScopes, ...action.scopes])] };
    case "transportStatus":
      return withStatus(state, action.status);
    case "sequence": {
      if (state.lastSequence !== null && action.sequence <= state.lastSequence) return state;
      return { ...state, lastSequence: action.sequence };
    }
    case "sequenceGap":
      if (state.lastSequence !== null && action.sequence <= state.lastSequence) return state;
      return {
        ...state,
        lastSequence: action.sequence,
        staleScopes: [...new Set([...state.staleScopes, ...action.scopes])],
      };
    case "reset":
      return initialAppState;
    default:
      return state;
  }
}
