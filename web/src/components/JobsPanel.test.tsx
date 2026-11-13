import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "../test/axe";
import { describe, expect, it, vi } from "vitest";
import { JobsPanel } from "./JobsPanel";
import type { Job } from "../api";

const base: Job = {
  id: "job-1",
  employer_wallet: "npc:professor-kofi",
  employee_account: "alice.testnet",
  title: "Research the archives",
  description: "Read and report",
  payment: "9007199254740993",
  status: "open",
  reference: "job:job-1",
  chain_tx: null,
};

describe("JobsPanel", () => {
  it("shows the empty state", () => {
    render(<JobsPanel jobs={[]} me={null} busy={false} onAccept={vi.fn()} onComplete={vi.fn()} />);
    expect(screen.getByText("No jobs posted.")).toBeInTheDocument();
  });

  it("offers the action for each state and disables it while busy", async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const { rerender } = render(
      <JobsPanel jobs={[base]} me="alice.testnet" busy={false} onAccept={onAccept} onComplete={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Accept job" }));
    expect(onAccept).toHaveBeenCalledTimes(1);

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "verified" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Get paid" })).toBeEnabled();

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "verified" }]}
        me="alice.testnet"
        busy
        onAccept={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Get paid" })).toBeDisabled();
  });

  it("shows pending, unknown, and paid states", () => {
    const { rerender } = render(
      <JobsPanel
        jobs={[{ ...base, status: "submitted" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByText("Awaiting operator verification")).toBeInTheDocument();

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "payment_unknown" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByText("payment_unknown")).toBeInTheDocument();

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "paid", chain_tx: "x".repeat(44) }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "reward tx" })).toBeInTheDocument();
  });

  it("renders accepted, payment-failed, and cancelled actions", async () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <JobsPanel
        jobs={[{ ...base, status: "accepted" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={onComplete}
      />,
    );
    expect(screen.getByRole("button", { name: "Submit work" })).toBeEnabled();

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "payment_failed" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={onComplete}
      />,
    );
    expect(screen.getByRole("button", { name: "Reconcile payment" })).toBeEnabled();

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "payment_pending" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={onComplete}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(
      <JobsPanel
        jobs={[{ ...base, status: "cancelled" }]}
        me="alice.testnet"
        busy={false}
        onAccept={vi.fn()}
        onComplete={onComplete}
      />,
    );
    expect(screen.getByText("cancelled")).toBeInTheDocument();
  });

  it("has no serious accessibility violations", async () => {
    const { container } = render(
      <JobsPanel jobs={[base]} me="alice.testnet" busy={false} onAccept={vi.fn()} onComplete={vi.fn()} />,
    );
    await expectAccessible(container);
  });
});
