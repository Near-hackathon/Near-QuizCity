import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import { api, type FriendMatch } from "../../api";
import { QuizMatches } from "./QuizMatches";
const room = (patch: Partial<FriendMatch> = {}): FriendMatch => ({
  id: "10000000-0000-4000-8000-000000000001",
  code: "AABBCCDDEE",
  visibility: "private",
  state: "waiting",
  outcome: null,
  winnerAccount: null,
  feePolicy: "deducted-2-v2",
  stake: "100",
  venueFee: "2",
  gasSupportFee: "0",
  totalDue: "100",
  prize: "196",
  joinExpiresAt: new Date(Date.now() + 900000).toISOString(),
  startsAt: null,
  endsAt: null,
  participants: [
    { accountId: "alice.testnet", username: "alice", funded: false, submitted: false, score: null },
  ],
  operation: {
    id: "op",
    kind: "quiz_fund",
    method: "fund_escrow",
    args: { id: "escrow" },
    status: "awaiting",
    tx_hash: null,
    reference: "fund:escrow",
    actor_account: "alice.testnet",
  },
  questions: [],
  review: [],
  transfers: [],
  ...patch,
});
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(api, "quizMatches").mockResolvedValue({ matches: [] });
  vi.spyOn(api, "publicQuizRooms").mockResolvedValue({ rooms: [] });
  vi.spyOn(api, "quizMatch").mockResolvedValue({ match: room() });
});
it("shows a loading spinner, fee breakdown and a saved room, then deposits exactly once and checks the same proof", async () => {
  let loaded!: (v: any) => void;
  vi.mocked(api.quizMatches).mockImplementation(() => new Promise((r) => (loaded = r)));
  const send = vi.fn().mockResolvedValue("t".repeat(43));
  const changed = vi.fn();
  render(<QuizMatches accountId="alice.testnet" online send={send} onBalanceChanged={changed} />);
  expect(screen.getByRole("status")).toHaveTextContent("Finding your quiz rooms");
  await act(async () => loaded({ matches: [] }));
  const create = vi.spyOn(api, "createQuizMatch").mockResolvedValue({ match: room() });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create a friend room" }));
  expect(create).toHaveBeenCalledWith(expect.any(String), "100");
  expect(screen.getByText("AABBCCDDEE")).toBeInTheDocument();
  expect(screen.getByText(/Actual NEAR transaction fees are separate/)).toBeInTheDocument();
  let deposited!: (v: any) => void;
  const confirm = vi
    .spyOn(api, "confirmQuizMatch")
    .mockImplementation(() => new Promise((r) => (deposited = r)));
  await user.click(screen.getByRole("button", { name: "Deposit 100 QC" }));
  expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("Depositing your stake"))).toBe(
    true,
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(room().id, "t".repeat(43));
  await act(async () =>
    deposited({
      match: room({
        participants: [
          { accountId: "alice.testnet", username: "alice", funded: true, submitted: false, score: null },
        ],
      }),
    }),
  );
  expect(screen.queryByRole("button", { name: "Deposit 100 QC" })).not.toBeInTheDocument();
  expect(screen.getByText(/Waiting for your opponent's confirmed stake/)).toBeInTheDocument();
  expect(changed).toHaveBeenCalledTimes(1);
});
it("joins by invite, retains unknown deposits across remounts and verifies a saved transaction without signing again", async () => {
  const unknown = room({ operation: { ...room().operation, status: "unknown", tx_hash: "s".repeat(43) } });
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [unknown] });
  const send = vi.fn();
  vi.spyOn(api, "confirmQuizMatch").mockResolvedValue({ match: unknown });
  render(<QuizMatches accountId="alice.testnet" online send={send} onBalanceChanged={() => {}} />);
  await screen.findByText("AABBCCDDEE");
  expect(screen.queryByRole("button", { name: /Deposit 100/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Check this payment" }));
  expect(send).not.toHaveBeenCalled();
  expect(api.confirmQuizMatch).toHaveBeenCalledWith(unknown.id, "s".repeat(43));
});
it("offers accessible radio choices, preserves drafts and disables input while scoring", async () => {
  const game = room({
    state: "playing",
    startsAt: new Date(Date.now() - 1000).toISOString(),
    endsAt: new Date(Date.now() + 120000).toISOString(),
    participants: [
      { accountId: "alice.testnet", username: "alice", funded: true, submitted: false, score: null },
    ],
    questions: [
      {
        id: "near",
        question: "What pays NEAR gas?",
        options: ["NEAR", "QC"],
        source: "https://docs.near.org/protocol/transactions/gas",
      },
    ],
  });
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [game] });
  let finish!: (value: any) => void;
  vi.spyOn(api, "submitQuizMatch").mockImplementation(() => new Promise((r) => (finish = r)));
  render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={() => {}} />);
  const radio = await screen.findByRole("radio", { name: "NEAR" });
  expect(screen.getByRole("button", { name: "Lock in answers" })).toBeDisabled();
  const user = userEvent.setup();
  await user.click(radio);
  expect(radio).toBeChecked();
  expect(screen.getByRole("radio", { name: "QC" })).not.toBeChecked();
  expect(sessionStorage.getItem(`quizcity.friend-answers:alice.testnet:${game.id}`)).toContain('"near":0');
  await user.click(screen.getByRole("button", { name: "Lock in answers" }));
  expect(radio).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Locking and scoring");
  await act(async () =>
    finish({
      match: { ...game, questions: [], participants: [{ ...game.participants[0], submitted: true }] },
    }),
  );
  expect(screen.getByText(/Answers locked. Waiting/)).toBeInTheDocument();
  expect(api.submitQuizMatch).toHaveBeenCalledWith(game.id, { near: 0 });
});
it("shows tie refunds, review sources and pending payout states inside the phone", async () => {
  const tied = room({
    state: "settling",
    outcome: "tie",
    participants: [
      { accountId: "alice.testnet", username: "alice", funded: true, submitted: true, score: 5 },
    ],
    questions: [
      {
        id: "near",
        question: "What pays NEAR gas?",
        options: ["NEAR", "QC"],
        source: "https://docs.near.org/protocol/transactions/gas",
      },
    ],
    review: [{ questionId: "near", correctIndex: 0, explanation: "Network gas is paid in native NEAR." }],
    transfers: [
      {
        kind: "refund",
        amount: "100",
        recipientWallet: "player:alice.testnet",
        state: "unknown",
        txHash: "s".repeat(43),
      },
    ],
  });
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [tied] });
  render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={() => {}} />);
  await screen.findByText("A draw — full QC refunds");
  expect(screen.getByText(/Confirming escrow payouts/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Review the NEAR lesson"));
  expect(screen.getByRole("link", { name: "Read the official NEAR source" })).toHaveAttribute(
    "href",
    "https://docs.near.org/protocol/transactions/gas",
  );
  expect(screen.getByText(/Funds stay in escrow/)).toBeInTheDocument();
});
it("join and cancelled lobby actions are contained in the phone and fail with safe feedback", async () => {
  vi.spyOn(api, "joinQuizMatch").mockRejectedValue(new Error("Visit the quiz centre to join."));
  render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={() => {}} />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Friend's invite code"), "aabbccddee");
  await user.click(screen.getByRole("button", { name: "Join room" }));
  expect(api.joinQuizMatch).toHaveBeenCalledWith(expect.any(String), "AABBCCDDEE");
  expect(screen.getByRole("alert")).toHaveTextContent("Visit the quiz centre to join.");
});
it("keeps an interrupted deposit pending across remounts and never signs it a second time", async () => {
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [room()] });
  const send = vi.fn().mockRejectedValue(new Error("The connection was interrupted."));
  const props = { accountId: "alice.testnet", online: true, send, onBalanceChanged: () => {} };
  const view = render(<QuizMatches {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "Deposit 100 QC" }));
  expect(screen.getByRole("alert")).toHaveTextContent("The connection was interrupted.");
  expect(send).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<QuizMatches {...props} />);
  await screen.findByText("AABBCCDDEE");
  expect(screen.queryByRole("button", { name: "Deposit 100 QC" })).not.toBeInTheDocument();
  expect(screen.getByText(/A delayed result does not start another payment/)).toBeInTheDocument();
  expect(send).toHaveBeenCalledTimes(1);
});
it("starts a new request after leaving a completed room with a different stake than the default input", async () => {
  const finished = room({
    state: "completed",
    outcome: "win",
    winnerAccount: "alice.testnet",
    stake: "150",
    venueFee: "3",
    totalDue: "150",
    prize: "294",
    participants: [
      { accountId: "alice.testnet", username: "alice", funded: true, submitted: true, score: 5 },
    ],
  });
  sessionStorage.setItem("quizcity.friend-room:alice.testnet", finished.id);
  sessionStorage.setItem("quizcity.friend-request:alice.testnet:create:150", "old-request");
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [finished] });
  const create = vi.spyOn(api, "createQuizMatch").mockResolvedValue({ match: room() });
  render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Back to friend rooms" }));
  await user.clear(screen.getByLabelText("Your stake (QC)"));
  await user.type(screen.getByLabelText("Your stake (QC)"), "150");
  await user.click(screen.getByRole("button", { name: "Create a friend room" }));
  expect(create).toHaveBeenCalledWith(expect.not.stringMatching("old-request"), "150");
});
it("polls saved results without a loading flash and updates the confirmed wallet after completion", async () => {
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [room()] });
  const intervals = vi.spyOn(window, "setInterval");
  const changed = vi.fn();
  render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={changed} />);
  await screen.findByText("AABBCCDDEE");
  const completed = room({
    state: "completed",
    outcome: "win",
    winnerAccount: "alice.testnet",
    participants: [
      { accountId: "alice.testnet", username: "alice", funded: true, submitted: true, score: 5 },
    ],
  });
  vi.mocked(api.quizMatch).mockResolvedValue({ match: completed });
  const poll = intervals.mock.calls.find(([, delay]) => delay === 1500)![0] as () => void;
  await act(async () => {
    poll();
  });
  expect(await screen.findByText("You won the round!")).toBeInTheDocument();
  expect(screen.queryByText("Finding your quiz rooms…")).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledTimes(1);
});
it("labels a legacy room honestly while new rooms deduct 2% without a QC gas charge", async () => {
  const old = room({
    feePolicy: "added-5-v1",
    stake: "20",
    venueFee: "1",
    gasSupportFee: "1",
    totalDue: "22",
    prize: "40",
  });
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [old] });
  const view = render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={() => {}} />);
  await screen.findByText("AABBCCDDEE");
  expect(screen.getByText("Saved centre fee · 5%, added to stake")).toBeInTheDocument();
  expect(screen.getByText("Saved QC gas-support charge")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Deposit 22 QC" })).toBeDisabled();
  view.unmount();
  vi.mocked(api.quizMatches).mockResolvedValue({ matches: [room()] });
  render(<QuizMatches accountId="alice.testnet" online onBalanceChanged={() => {}} />);
  await screen.findByText("AABBCCDDEE");
  expect(screen.getByText("Quiz centre · 2%, deducted from stake")).toBeInTheDocument();
  expect(screen.queryByText("Saved QC gas-support charge")).not.toBeInTheDocument();
  expect(screen.getByText(/No QC gas-support charge/)).toBeInTheDocument();
});
it("publishes a room explicitly, shows searching and stops without charging a stake", async () => {
  const publicRoom = room({ visibility: "public" });
  vi.spyOn(api, "createQuizMatch").mockResolvedValue({ match: publicRoom });
  vi.spyOn(api, "cancelQuizMatch").mockResolvedValue({
    match: { ...publicRoom, state: "settling", outcome: "cancelled" },
  });
  const send = vi.fn();
  render(<QuizMatches accountId="alice.testnet" online send={send} onBalanceChanged={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText("List this room publicly"));
  await user.click(screen.getByRole("button", { name: "Create public room" }));
  expect(api.createQuizMatch).toHaveBeenCalledWith(expect.any(String), "100", "public");
  expect(screen.getByText(/Searching for an opponent at 100 QC/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Deposit 100 QC" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Stop searching" }));
  expect(api.cancelQuizMatch).toHaveBeenCalledWith(publicRoom.id);
  expect(send).not.toHaveBeenCalled();
});
it("finds an opponent at the chosen stake and enables deposit only after the partner arrives", async () => {
  const searching = room({ visibility: "public" });
  vi.spyOn(api, "findQuizOpponent").mockResolvedValue({ match: searching });
  const intervals = vi.spyOn(window, "setInterval"),
    send = vi.fn();
  render(<QuizMatches accountId="alice.testnet" online send={send} onBalanceChanged={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Find an opponent" }));
  expect(api.findQuizOpponent).toHaveBeenCalledWith(expect.any(String), "100");
  expect(screen.getByRole("button", { name: "Deposit 100 QC" })).toBeDisabled();
  const paired = {
    ...searching,
    participants: [
      ...searching.participants,
      { accountId: "bob.testnet", username: "bob", funded: false, submitted: false, score: null },
    ],
  };
  vi.mocked(api.quizMatch).mockResolvedValue({ match: paired });
  const poll = intervals.mock.calls.find(([, delay]) => delay === 1500)![0] as () => void;
  await act(async () => {
    poll();
  });
  expect(screen.getByText(/Opponent found!/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Deposit 100 QC" })).toBeEnabled();
  expect(send).not.toHaveBeenCalled();
});
it("browses and joins a public room without an invite code or automatic payment", async () => {
  vi.mocked(api.publicQuizRooms).mockResolvedValue({
    rooms: [
      {
        id: room().id,
        host: "bob",
        stake: "150",
        venueFee: "3",
        prize: "294",
        expiresAt: room().joinExpiresAt,
      },
    ],
  });
  const joined = room({
    visibility: "public",
    stake: "150",
    venueFee: "3",
    totalDue: "150",
    prize: "294",
    participants: [
      { accountId: "bob.testnet", username: "bob", funded: false, submitted: false, score: null },
      ...room().participants,
    ],
  });
  vi.spyOn(api, "joinPublicQuizRoom").mockResolvedValue({ match: joined });
  const send = vi.fn();
  render(<QuizMatches accountId="alice.testnet" online send={send} onBalanceChanged={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Join bob" }));
  expect(api.joinPublicQuizRoom).toHaveBeenCalledWith(room().id, expect.any(String));
  expect(screen.getByRole("button", { name: "Deposit 150 QC" })).toBeEnabled();
  expect(send).not.toHaveBeenCalled();
});
