import { render, screen } from "@testing-library/react";
import { expectAccessible } from "../test/axe";
import { describe, expect, it } from "vitest";
import { Ledger } from "./Ledger";
import type { Tx, Wallet } from "../api";

const wallet: Wallet = {
  wallet_id: "player:alice.testnet",
  owner_type: "player",
  balance: "9007199254740993",
  updated_at: "2026-11-13T00:00:00.000Z",
};

const tx: Tx = {
  seq: 1,
  tx_hash: null,
  wallet_from: null,
  wallet_to: "player:alice.testnet",
  amount: "0",
  kind: "mint",
  event_name: "reward_issued",
  reference: "quiz:1",
  created_at: "2026-11-13T00:00:00.000Z",
};

describe("Ledger", () => {
  it("shows empty states", () => {
    render(<Ledger wallets={[]} transactions={[]} />);
    expect(screen.getByText("no wallets yet")).toBeInTheDocument();
    expect(screen.getByText("no transactions yet")).toBeInTheDocument();
  });

  it("renders exact large amounts and canonical direction", () => {
    render(<Ledger wallets={[wallet]} transactions={[tx]} />);
    expect(screen.getByText("9,007,199,254,740,993 QC")).toBeInTheDocument();
    expect(screen.getByText(/mint →/)).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });

  it("has no serious accessibility violations", async () => {
    const { container } = render(<Ledger wallets={[wallet]} transactions={[tx]} />);
    await expectAccessible(container);
  });
});
