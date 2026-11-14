import { act } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { StateProvider } from "../../state/StateProvider";
import { createGameBridge } from "../bridge/GameBridge";
import { expectAccessible } from "../../test/axe";
import { GameUi } from "./GameUi";
import { api, ApiError, type Job } from "../../api";
import type { WorldEventType } from "@quiz-city/protocol";
import { worldBootstrap } from "../../test/world-fixtures";
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  api: {
    cityOverview: vi.fn(),
    authMe: vi.fn(),
    myOrders: vi.fn(),
    catalogue: vi.fn(),
    commerceCapabilities: vi.fn(),
    profiles: vi.fn(),
    managedWalletStatus: vi.fn(),
    player: vi.fn(),
    jobs: vi.fn(),
    properties: vi.fn(),
    businesses: vi.fn(),
    buyProperty: vi.fn(),
    acceptJob: vi.fn(),
    quizzes: vi.fn(),
    startQuiz: vi.fn(),
    submitQuiz: vi.fn(),
  },
}));
beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.cityOverview).mockResolvedValue({
    operations: [],
    admissions: [],
    purchases: [],
    sales: [],
    suppliers: [],
    items: [],
    businessSales: [],
    jobs: [],
    leases: [],
    rentOffers: [],
    drafts: [],
    staff: [],
    shops: [],
    market: [],
    policy: { available: false, dailyCap: "0", issuedToday: "0" },
  });
  vi.mocked(api.authMe).mockResolvedValue({
    accountId: "alice.testnet",
    roles: ["player"],
    expiresAt: "2026-11-15T00:00:00Z",
  });
  vi.mocked(api.profiles).mockResolvedValue({ profiles: [] });
  vi.mocked(api.myOrders).mockResolvedValue({ orders: [] });
  vi.mocked(api.catalogue).mockResolvedValue({ items: [] });
  vi.mocked(api.commerceCapabilities).mockResolvedValue({ orderPayments: false });
  // DOM-only accessibility checks have no canvas text measurement.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.mocked(api.player).mockResolvedValue({
    account_id: "alice.testnet",
    username: "Alice",
    reputation: 0,
    created_at: "2026-01-01",
    wallet: { balance: "9007199254740993", updated_at: "2026-01-01" },
  });
  vi.mocked(api.jobs).mockResolvedValue([]);
  vi.mocked(api.quizzes).mockResolvedValue([]);
  vi.mocked(api.properties).mockResolvedValue([]);
  vi.mocked(api.businesses).mockResolvedValue([]);
});
function mount(
  onSignOut = vi.fn().mockResolvedValue(undefined),
  extra: Partial<React.ComponentProps<typeof GameUi>> = {},
) {
  const bridge = createGameBridge();
  const view = render(
    <StateProvider>
      <MemoryRouter>
        <GameUi
          bridge={bridge}
          accountId="alice.testnet"
          networkId="testnet"
          status="online"
          onSignOut={onSignOut}
          {...extra}
        />
      </MemoryRouter>
    </StateProvider>,
  );
  return { bridge, ...view };
}
it("renders exact confirmed balances and accessible keyboard phone, credits and settings", async () => {
  const { container, bridge } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("9,007,199,254,740,993")).toBeInTheDocument();
  await expectAccessible(container);
  const user = userEvent.setup();
  const opener = screen.getByRole("button", { name: "Open city phone" });
  fireEvent.click(screen.getByRole("button", { name: "Close Your city phone" }));
  await user.click(opener);
  expect(screen.getByRole("dialog")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Credits" }));
  expect(screen.getByRole("link", { name: "Art by Gridwright" })).toHaveAttribute(
    "href",
    "https://gridwrightstudio.itch.io",
  );
  await expectAccessible(container);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByLabelText("Reduced motion"));
  expect(JSON.parse(localStorage.getItem("quizcity.game-settings.v1")!).reducedMotion).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  act(() => bridge.emit({ type: "interactionCompleted", targetId: "professor-kofi", kind: "npc" }));
  expect(screen.getByRole("dialog", { name: "Professor Reed" })).toBeInTheDocument();
});

const phoneJob = {
  id: "phone-job",
  title: "Research for Kofi",
  description: "Read the city archives.",
  payment: "100",
  status: "open",
  employer_wallet: "npc:professor-kofi",
  employee_account: null,
  reference: "job:phone-job",
  chain_tx: null,
};

it("accepts a job inside the phone once and immediately shows the assignment", async () => {
  vi.mocked(api.jobs).mockResolvedValue([phoneJob]);
  let finish!: (value: Job) => void;
  vi.mocked(api.acceptJob).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  const accept = await screen.findByRole("button", { name: "Accept job" });
  await user.dblClick(accept);
  expect(api.acceptJob).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();
  const accepted = { ...phoneJob, status: "accepted", employee_account: "alice.testnet" };
  vi.mocked(api.jobs).mockResolvedValue([accepted]);
  await act(async () => finish(accepted));
  expect(await screen.findByText("Assigned to you")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Accept job" })).not.toBeInTheDocument();
});

it("shows a rejected acceptance without inventing an assignment", async () => {
  vi.mocked(api.jobs).mockResolvedValue([phoneJob]);
  vi.mocked(api.acceptJob).mockRejectedValue(new ApiError("This job is no longer open", 409, "CONFLICT"));
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  await user.click(await screen.findByRole("button", { name: "Accept job" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This job is no longer open");
  expect(screen.queryByText("Assigned to you")).not.toBeInTheDocument();
});

it("offers wallet setup in the phone and refreshes only after confirmation", async () => {
  vi.mocked(api.player).mockRejectedValue(new ApiError("player not found", 404, "NOT_FOUND"));
  const setup = vi.fn(async () => {
    vi.mocked(api.player).mockResolvedValue({
      account_id: "alice.testnet",
      username: "Alice",
      reputation: 0,
      created_at: "2026-01-01",
      wallet: { balance: "500", updated_at: "2026-01-01" },
    });
  });
  mount(undefined, { onSetupWallet: setup });
  await waitFor(() => expect(api.player).toHaveBeenCalled());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  await user.click(screen.getByRole("button", { name: "Wallet" }));
  await user.click(screen.getByRole("button", { name: "Set up QC wallet / claim starter" }));
  expect(setup).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("500 QC")).toBeInTheDocument();
});

it("uses a confirmed chain balance when the mirror has no player yet", async () => {
  vi.mocked(api.player).mockRejectedValue(new ApiError("player not found", 404, "NOT_FOUND"));
  mount(undefined, { onReadWallet: vi.fn().mockResolvedValue("9007199254740993") });
  fireEvent.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("9,007,199,254,740,993")).toBeInTheDocument();
  expect(screen.queryByText("QC registration not confirmed")).not.toBeInTheDocument();
});

it("keeps the confirmed zero visible during polling, preserves it on failure, and applies a later balance", async () => {
  const intervals = vi.spyOn(window, "setInterval");
  vi.mocked(api.player).mockRejectedValue(new ApiError("player not found", 404, "NOT_FOUND"));
  let rejectRead!: (error: Error) => void;
  const readWallet = vi
    .fn()
    .mockResolvedValueOnce("0")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    )
    .mockResolvedValueOnce("500");
  mount(undefined, { onReadWallet: readWallet });
  fireEvent.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("0")).toBeInTheDocument();
  const poll = intervals.mock.calls.find(([, delay]) => delay === 20_000)![0] as () => void;
  act(() => poll());
  await waitFor(() => expect(readWallet).toHaveBeenCalledTimes(2));
  expect(screen.getByText("0")).toBeInTheDocument();
  expect(screen.queryByText("QC registration not confirmed")).not.toBeInTheDocument();
  await act(async () => rejectRead(new Error("temporary provider failure")));
  expect(screen.getByText("0")).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("could not refresh");
  act(() => poll());
  expect(await screen.findByText("500")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("reports read failures with retry and never guesses a zero balance", async () => {
  vi.mocked(api.player).mockRejectedValue(new Error("database internals must not appear"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("could not refresh");
  expect(screen.queryByText("database internals must not appear")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.player).toHaveBeenCalledTimes(2));
});

it("shows a closed venue's hours instead of an actionable Visit button", async () => {
  const { bridge } = mount();
  await waitFor(() => expect(api.player).toHaveBeenCalled());
  act(() =>
    bridge.emit({
      type: "interactionCandidateChanged",
      targetId: "library-door-exterior",
      label: "Library · 08:00–20:00 (Accra)",
      available: false,
    }),
  );
  expect(screen.getByText("Closed: Library · 08:00–20:00 (Accra)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Visit Library/ })).not.toBeInTheDocument();
  act(() =>
    bridge.emit({
      type: "interactionCandidateChanged",
      targetId: "library-door-exterior",
      label: "Library",
      available: true,
    }),
  );
  expect(screen.getByRole("button", { name: /Visit Library/ })).toBeInTheDocument();
});

it("treats a missing player record as unconfirmed QC registration, not a world failure", async () => {
  vi.mocked(api.player).mockRejectedValue(new ApiError("player not found", 404, "NOT_FOUND"));
  mount();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  await user.click(screen.getByRole("button", { name: "Wallet" }));
  expect(
    screen.getByText("You are signed in. QC registration has not been confirmed here yet."),
  ).toBeInTheDocument();
  expect(screen.getByText("You can explore the city without a registered QC account.")).toBeInTheDocument();
});

it("loads the job board even when the player's wallet lookup fails", async () => {
  vi.mocked(api.player).mockRejectedValueOnce(new Error("not registered"));
  vi.mocked(api.jobs).mockResolvedValueOnce([
    {
      id: "job-visible",
      title: "Visible research job",
      description: "Research",
      payment: "100",
      status: "open",
      employer_wallet: "npc:professor-kofi",
    } as never,
  ]);
  mount();
  const user = userEvent.setup();
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("Visible research job")).toBeInTheDocument();
});

it("shows the NPC directory and supports keyboard dialogue with input paused", async () => {
  const { bridge, container } = mount();
  const settings = vi.fn();
  bridge.onReact(settings);
  const bootstrap = worldBootstrap();
  bootstrap.npcDirectory = [{ npcId: "professor-kofi", sceneId: "apartment-interior", activity: "home" }];
  act(() => bridge.send({ type: "bootstrap", bootstrap }));
  const user = userEvent.setup();
  const opener = screen.getByRole("button", { name: "Open city phone" });
  await user.click(opener);
  await user.click(screen.getByRole("button", { name: "Help" }));
  expect(screen.getByText(/Professor Reed \(Research professor\): apartment interior/)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  act(() => bridge.emit({ type: "interactionCompleted", targetId: "professor-kofi", kind: "npc" }));
  expect(screen.getByRole("dialog", { name: "Professor Reed" })).toHaveFocus();
  expect(settings).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "settingsChanged",
      settings: expect.objectContaining({ uiModalOpen: true }),
    }),
  );
  await expectAccessible(container);
  await user.keyboard("{Tab}");
  expect(screen.getByRole("button", { name: "Close Professor Reed" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  expect(settings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "settingsChanged",
      settings: expect.objectContaining({ uiModalOpen: false }),
    }),
  );
});

it("the quiz attendant opens a real phone quiz flow and keeps pending rewards out of the wallet", async () => {
  vi.mocked(api.quizzes).mockResolvedValue([
    {
      id: "daily-quiz",
      title: "City knowledge",
      reward_pool: "100",
      entry_fee: "0",
      status: "live",
      questions: 1,
    },
  ]);
  vi.mocked(api.startQuiz).mockResolvedValue({
    attemptId: "attempt",
    quizId: "daily-quiz",
    questions: [
      { id: "q1", question: "Which place has books?", options: ["Library", "Road"], category: "city" },
    ],
  });
  vi.mocked(api.submitQuiz).mockResolvedValue({
    score: 1,
    total: 1,
    reward: "0",
    txHash: null,
    alreadySubmitted: false,
    status: "reward_pending",
  });
  const { bridge, container } = mount();
  await waitFor(() => expect(api.player).toHaveBeenCalled());
  act(() => bridge.emit({ type: "interactionCompleted", targetId: "quiz-attendant-yaw", kind: "npc" }));
  expect(screen.getByRole("dialog", { name: "Max" })).toHaveFocus();
  expect(screen.getByText("Quiz attendant")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Choose a quiz" }));
  await user.click(await screen.findByRole("button", { name: "Choose quiz" }));
  await user.click(screen.getByRole("button", { name: "Start quiz" }));
  await user.click(await screen.findByRole("radio", { name: "Library" }));
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  expect(await screen.findByText(/Reward pending confirmation/)).toBeInTheDocument();
  expect(api.startQuiz).toHaveBeenCalledExactlyOnceWith("daily-quiz");
  expect(api.submitQuiz).toHaveBeenCalledExactlyOnceWith("daily-quiz", "attempt", { q1: 0 });
  expect(screen.getByText("9,007,199,254,740,993")).toBeInTheDocument();
  await expectAccessible(container);
});

it.each([
  ["librarian-ama", "Emma", "Browse research jobs", "Jobs"],
  ["barista-esi", "Sam", "View businesses", "Business"],
  ["resident-kojo", "Alex", "Find residents", "Help"],
])("resident %s has role-specific dialogue and phone actions", async (id, name, action, section) => {
  const { bridge } = mount();
  await waitFor(() => expect(api.player).toHaveBeenCalled());
  act(() => bridge.emit({ type: "interactionCompleted", targetId: id, kind: "npc" }));
  expect(screen.getByRole("dialog", { name })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: action }));
  expect(screen.getByRole("region", { name: section })).toBeInTheDocument();
});

it("a rejected phone quiz start shows its safe error and creates no result or reward", async () => {
  vi.mocked(api.quizzes).mockResolvedValue([
    {
      id: "closed-quiz",
      title: "City knowledge",
      reward_pool: "100",
      entry_fee: "0",
      status: "live",
      questions: 1,
    },
  ]);
  vi.mocked(api.startQuiz).mockRejectedValue(
    new ApiError("This quiz is no longer available", 409, "QUIZ_UNAVAILABLE"),
  );
  vi.mocked(api.submitQuiz).mockClear();
  mount();
  await waitFor(() => expect(api.player).toHaveBeenCalled());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  await user.click(screen.getByRole("button", { name: "Quizzes" }));
  await user.click(await screen.findByRole("button", { name: "Choose quiz" }));
  await user.click(screen.getByRole("button", { name: "Start quiz" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This quiz is no longer available");
  expect(api.submitQuiz).not.toHaveBeenCalled();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(screen.getByText("9,007,199,254,740,993")).toBeInTheDocument();
});

it("offers sign-out from every phone section and prevents repeat submission", async () => {
  let finish!: () => void;
  const signOut = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { container } = mount(signOut);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  for (const tab of ["Jobs", "Wallet", "Property", "Business", "Settings", "Help", "Credits"]) {
    await user.click(screen.getByRole("button", { name: tab }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  }
  await expectAccessible(container);
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Signing out…" }));
  expect(signOut).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

it("shows a safe retry message when sign-out cannot complete", async () => {
  const signOut = vi
    .fn()
    .mockRejectedValueOnce(new Error("private provider details"))
    .mockResolvedValueOnce(undefined);
  mount(signOut);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not sign out");
  expect(screen.queryByText("private provider details")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(signOut).toHaveBeenCalledTimes(2);
});

it("distinguishes payment states, deduplicates notices and pauses the doorway prompt", async () => {
  const { bridge, container } = mount();
  await waitFor(() => expect(api.player).toHaveBeenCalled());
  for (const [index, status, label] of [
    [1, "payment_pending", "Payment pending confirmation"],
    [2, "payment_unknown", "Payment outcome unknown"],
    [3, "payment_failed", "Payment failed"],
    [4, "paid", "Job payment confirmed"],
  ] as const) {
    const event: WorldEventType = {
      type: "job.presentation_changed",
      protocolVersion: "1.0.0",
      eventId: `job-${index}`,
      streamId: "scene:city-district",
      sequence: String(index),
      sceneId: "city-district",
      serverTime: "2026-11-13T10:00:00Z",
      cityTime: "2026-11-13T10:00:00Z",
      entity: { entityType: "job", entityId: "job-1" },
      payload: { jobId: "job-1", status, txHash: null },
    };
    await act(async () => bridge.send({ type: "worldEvent", event }));
    expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
    expect(screen.queryByLabelText("City status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await act(async () => bridge.send({ type: "worldEvent", event }));
    expect(screen.queryByText(new RegExp(label))).not.toBeInTheDocument();
  }
  act(() => bridge.emit({ type: "interactionCandidateChanged", targetId: "library", label: "Library" }));
  expect(screen.getByRole("button", { name: /Visit Library/ })).toBeInTheDocument();
  act(() => bridge.emit({ type: "transitionStatus", pending: true }));
  expect(screen.queryByRole("button", { name: /Visit Library/ })).not.toBeInTheDocument();
  expect(screen.getByText("Entering building…")).toBeInTheDocument();
  await expectAccessible(container);
});

it("buys a plot from the phone using a numeric contract ID and keeps the player in the modal", async () => {
  vi.mocked(api.properties).mockResolvedValue([
    {
      id: "1",
      district: "knowledge",
      x: 22,
      y: 20,
      owner_wallet: "npc:professor-kofi",
      property_type: "commercial",
      price: "300",
      for_sale: true,
      transfer_count: 0,
    } as never,
  ]);
  vi.mocked(api.buyProperty).mockResolvedValue({} as never);
  const send = vi.fn().mockResolvedValue("transaction-proof");
  mount(undefined, { onTransaction: send });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open city phone" }));
  await user.click(screen.getByRole("button", { name: "Property" }));
  await user.click(await screen.findByRole("button", { name: "Buy for 300 QC" }));
  await waitFor(() => expect(api.buyProperty).toHaveBeenCalledWith("1", "transaction-proof"));
  expect(send).toHaveBeenCalledWith("buy_property", { property_id: 1 });
  expect(screen.getByRole("dialog", { name: "Your city phone" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /manage property/ })).not.toBeInTheDocument();
});

it("opens world plot and quiz inspections directly inside the phone", async () => {
  const { bridge } = mount();
  await act(async () => {});
  act(() => bridge.emit({ type: "interactionCompleted", kind: "property", targetId: "1" }));
  expect(screen.getByRole("dialog", { name: "Your city phone" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Property" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close Your city phone" }));
  act(() => bridge.emit({ type: "interactionCompleted", kind: "quiz", targetId: "quiz-desk" }));
  expect(screen.getByRole("region", { name: "Quizzes" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "quiz desk" })).not.toBeInTheDocument();
});

const managedResident = {
  id: "00000000-0000-4000-8000-000000000081",
  username: "reader",
  firstName: "Richmond",
  accountId: "guest-00000000-0000-4000-8000-000000000081",
  walletKind: "embedded" as const,
  walletLinked: false,
  onboardingComplete: true,
};
it("shows the allocated account and contract gate in the phone summary instead of asking to connect", async () => {
  vi.mocked(api.profiles).mockResolvedValue({ profiles: [managedResident] });
  vi.mocked(api.managedWalletStatus).mockResolvedValue({
    enabled: true,
    accountId: "qc-reader.testnet",
    stage: "registering",
    errorCode: "CONTRACT_UPGRADE_REQUIRED",
    retryAt: null,
  });
  const setup = vi.fn(),
    connect = vi.fn();
  mount(undefined, { accountId: managedResident.accountId, onSetupWallet: setup, onConnectWallet: connect });
  fireEvent.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("QC pending · city contract update required")).toBeInTheDocument();
  expect(screen.getByText("qc-reader.testnet")).toBeInTheDocument();
  expect(screen.queryByText("Connect your city wallet")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "View wallet setup" }));
  expect(await screen.findByText(/No manual wallet connection is needed/)).toBeInTheDocument();
  const walletPanel = screen.getByRole("region", { name: "Wallet" });
  const brief = within(walletPanel).getByRole("status", { name: "Wallet setup progress" });
  expect(brief).toHaveTextContent("Waiting for a city update");
  expect(
    brief.compareDocumentPosition(within(walletPanel).getByRole("heading", { name: "Wallet balance" })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  expect(screen.queryByRole("button", { name: "Set up QC wallet / claim starter" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect or recover wallet" })).not.toBeInTheDocument();
  expect(setup).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
it("distinguishes account creation from pending QC and cancels phone status checks on close", async () => {
  vi.mocked(api.profiles).mockResolvedValue({ profiles: [managedResident] });
  vi.mocked(api.managedWalletStatus).mockResolvedValue({
    enabled: true,
    accountId: "qc-reader.testnet",
    stage: "creating_account",
    errorCode: null,
    retryAt: null,
  });
  mount(undefined, { accountId: managedResident.accountId });
  fireEvent.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("Creating your testnet account")).toBeInTheDocument();
  const signal = vi.mocked(api.managedWalletStatus).mock.calls.at(-1)?.[1]?.signal;
  await userEvent.click(screen.getByRole("button", { name: "Close Your city phone" }));
  expect(signal?.aborted).toBe(true);
});
it("keeps managed setup honest when its status request fails", async () => {
  vi.mocked(api.profiles).mockResolvedValue({ profiles: [managedResident] });
  vi.mocked(api.managedWalletStatus).mockRejectedValue(Error("private provider detail"));
  mount(undefined, { accountId: managedResident.accountId });
  fireEvent.click(screen.getByRole("button", { name: "Open city phone" }));
  expect(await screen.findByText("Wallet setup status unavailable · rechecking")).toBeInTheDocument();
  expect(screen.queryByText("Connect your city wallet")).not.toBeInTheDocument();
  expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
});
