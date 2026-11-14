import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, vi, expect } from "vitest";
import { api } from "../../api";
import { ResearchAssignment } from "./ResearchAssignment";
it("pairs each readable choice with its radio, supports keyboard selection and displays loading/scoring status", async () => {
  sessionStorage.clear();
  let loaded!: (v: any) => void;
  vi.spyOn(api, "researchTask").mockImplementation(() => new Promise((r) => (loaded = r)));
  const done = vi.fn();
  render(
    <div className="city-modal">
      <ResearchAssignment jobId="job" accountId="alice.testnet" disabled={false} onUpdated={done} />
    </div>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Opening your assignment");
  await act(async () =>
    loaded({
      version: "near",
      title: "NEAR research",
      reading: "Learn about NEAR",
      source: "https://near.org",
      questions: [{ id: "near", question: "What is NEAR?", options: ["A blockchain", "A search engine"] }],
    }),
  );
  const user = userEvent.setup();
  const radio = screen.getByRole("radio", { name: "A blockchain" });
  radio.focus();
  await user.keyboard(" ");
  expect(radio).toBeChecked();
  expect(screen.getByRole("radio", { name: "A search engine" })).not.toBeChecked();
  const summary = screen.getByRole("textbox");
  await user.type(summary, "NEAR is a blockchain for applications.");
  let finished!: (v: any) => void;
  vi.spyOn(api, "submitResearch").mockImplementation(() => new Promise((r) => (finished = r)));
  await user.click(screen.getByRole("button", { name: /Submit/ }));
  expect(radio).toBeDisabled();
  expect(screen.getByRole("button", { name: /Checking research/ })).toBeDisabled();
  await act(async () => finished({ score: 1, total: 1, job: { id: "job" } }));
  expect(done).toHaveBeenCalledWith({ id: "job" });
});
