import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { QuizPanel } from "./JobsPanel";
it("restores a quiz snapshot and answers, shows server expiry and finishes expired without a reward", async () => {
  sessionStorage.clear();
  let now = Date.parse("2026-11-14T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const intervals = vi.spyOn(window, "setInterval");
  const start = vi.fn().mockResolvedValue({
    attemptId: "saved-attempt",
    expiresAt: new Date(now + 2000).toISOString(),
    passScore: 1,
    rewardAmount: "25",
    questions: [{ id: "q1", question: "Choose one", options: ["A", "B"], category: null }],
  });
  const submit = vi
    .fn()
    .mockResolvedValue({ score: 0, total: 1, reward: "0", txHash: null, status: "expired" });
  const props = { me: "alice.testnet", busy: false, start, submit, storageKey: "quiz-test" };
  const view = render(<QuizPanel {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Start quiz" }));
  await user.click(screen.getByLabelText("A"));
  expect(screen.getByRole("timer")).toHaveTextContent("0:02");
  view.unmount();
  render(<QuizPanel {...props} />);
  expect(screen.getByLabelText("A")).toBeChecked();
  expect(start).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
  const tick = intervals.mock.calls.filter(([, delay]) => delay === 1000).at(-1)![0] as () => void;
  act(() => {
    now += 3000;
    tick();
  });
  expect(screen.getByLabelText("A")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Finish expired attempt" }));
  expect(await screen.findByText("0/1 correct")).toBeInTheDocument();
  expect(submit).toHaveBeenCalledWith("saved-attempt", { q1: 0 });
  expect(sessionStorage.getItem("quiz-test")).toBeNull();
});
