import { describe, expect, it } from "vitest";
import { appReducer } from "./reducer";
import { initialAppState } from "./entities";
import type { Job, Property, Wallet } from "../api";

const property: Property = {
  id: "1",
  district: "knowledge",
  x: 1,
  y: 1,
  owner_wallet: "player:alice.testnet",
  property_type: "venue",
  price: "300",
  for_sale: true,
  transfer_count: "0",
};
const wallet: Wallet = {
  wallet_id: "player:alice.testnet",
  owner_type: "player",
  balance: "25",
  updated_at: "2026-11-13T00:00:00.000Z",
  last_tx_hash: null,
};
const job: Job = {
  id: "job-1",
  employer_wallet: "npc:professor-kofi",
  employee_account: "alice.testnet",
  title: "Job",
  description: "desc",
  payment: "100",
  status: "open",
  reference: "job:job-1",
  chain_tx: null,
};

describe("state reducer", () => {
  it("normalizes lists and upserts without duplicate entity rows", () => {
    let state = appReducer(initialAppState, { type: "properties", items: [property] });
    state = appReducer(state, {
      type: "properties",
      items: [{ ...property, price: "400" }],
    });
    expect(state.lists.propertyIds).toEqual(["1"]);
    expect(state.entities.properties["1"].price).toBe("400");

    state = appReducer(state, { type: "wallets", items: [wallet] });
    state = appReducer(state, { type: "wallets", items: [{ ...wallet, balance: "50" }] });
    expect(state.lists.walletIds).toEqual(["player:alice.testnet"]);
    expect(state.entities.wallets["player:alice.testnet"].balance).toBe("50");
  });

  it("removes entities from both the map and the ordered list", () => {
    let state = appReducer(initialAppState, { type: "jobs", items: [job] });
    state = appReducer(state, { type: "remove", query: "jobs", id: "job-1" });
    expect(state.entities.jobs).toEqual({});
    expect(state.lists.jobIds).toEqual([]);
  });

  it("tracks invalidation and clears it on a scoped bootstrap success", () => {
    let state = appReducer(initialAppState, { type: "invalidate", scopes: ["jobs", "economy"] });
    expect(state.staleScopes).toEqual(["jobs", "economy"]);
    state = appReducer(state, { type: "bootstrapSuccess", scope: "jobs" });
    expect(state.staleScopes).toEqual(["economy"]);
  });

  it("ignores duplicate/older sequences and records forward gaps", () => {
    let state = appReducer(initialAppState, { type: "sequence", sequence: 5 });
    state = appReducer(state, { type: "sequence", sequence: 5 });
    state = appReducer(state, { type: "sequence", sequence: 4 });
    expect(state.lastSequence).toBe(5);

    state = appReducer(state, { type: "sequenceGap", sequence: 9, scopes: ["jobs"] });
    expect(state.lastSequence).toBe(9);
    expect(state.staleScopes).toEqual(["jobs"]);
  });

  it("resets account-scoped state and transport status", () => {
    let state = appReducer(initialAppState, { type: "jobs", items: [job] });
    state = appReducer(state, { type: "transportStatus", status: "reconnecting" });
    expect(state.status).toBe("reconnecting");
    state = appReducer(state, { type: "reset" });
    expect(state).toEqual(initialAppState);
  });
});
