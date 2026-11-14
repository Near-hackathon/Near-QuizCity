import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WelcomeGuide } from "./WelcomeGuide";
import { api } from "../../api";
import { createGameBridge } from "../bridge/GameBridge";
vi.mock("../../api", () => ({ api: { profiles: vi.fn(), finishOnboarding: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.profiles).mockResolvedValue({
    profiles: [{ accountId: "guest-player", onboardingComplete: false } as never],
  });
});
it("guides a first visit, submits three answers and resumes play only after saved success", async () => {
  const bridge = createGameBridge(),
    sent = vi.fn();
  bridge.onReact(sent);
  const onOpenPhone = vi.fn();
  render(<WelcomeGuide accountId="guest-player" online bridge={bridge} onOpenPhone={onOpenPhone} />);
  const user = userEvent.setup();
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Show me around/ }));
  await user.click(screen.getByRole("button", { name: "A blockchain for building applications" }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: "Execute actions across different blockchains" }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: "You — keep them private" }));
  vi.mocked(api.finishOnboarding).mockResolvedValue({ complete: true, score: 3, total: 3 });
  await user.click(screen.getByRole("button", { name: "Finish my welcome" }));
  expect(await screen.findByText("You’re one of us now.")).toBeInTheDocument();
  expect(api.finishOnboarding).toHaveBeenCalledWith([0, 1, 2]);
  await user.click(screen.getByRole("button", { name: "Let me explore" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("does not replay a completed tour", async () => {
  vi.mocked(api.profiles).mockResolvedValue({
    profiles: [{ accountId: "guest-player", onboardingComplete: true } as never],
  });
  render(<WelcomeGuide accountId="guest-player" online bridge={null} onOpenPhone={vi.fn()} />);
  await waitFor(() => expect(api.profiles).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
