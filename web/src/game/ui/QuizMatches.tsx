import { useEffect, useRef, useState } from "react";
import { api, type FriendMatch } from "../../api";
import { LoadingStatus, Spinner } from "../../components/LoadingStatus";
const formatQc = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
import "./QuizMatches.css";
const save = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* Server keeps the authoritative room and receipts. */
  }
};
const read = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
export function QuizMatches({
  accountId,
  online,
  send,
  onBalanceChanged,
}: {
  accountId: string;
  online: boolean;
  send?: (method: string, args: Record<string, unknown>) => Promise<string>;
  onBalanceChanged: () => void;
}) {
  const [room, setRoom] = useState<FriendMatch | null>(null),
    [rooms, setRooms] = useState<FriendMatch[]>([]),
    [loading, setLoading] = useState(true),
    [working, setWorking] = useState<string | null>(null),
    [error, setError] = useState(""),
    [stake, setStake] = useState("100"),
    [isPublic, setIsPublic] = useState(false),
    [publicRooms, setPublicRooms] = useState<Awaited<ReturnType<typeof api.publicQuizRooms>>["rooms"]>([]),
    [roomSearch, setRoomSearch] = useState(""),
    [stakeFilter, setStakeFilter] = useState(""),
    [publicLoading, setPublicLoading] = useState(false),
    [publicError, setPublicError] = useState(""),
    [clock, setClock] = useState(Date.now()),
    [proof, setProof] = useState(""),
    [answers, setAnswers] = useState<Record<string, number>>({});
  const active = useRef(true),
    busy = useRef(false),
    selection = useRef<string | null>(null);
  const roomKey = `quizcity.friend-room:${accountId}`;
  function choose(next: FriendMatch) {
    selection.current = next.id;
    setRoom(next);
    save(roomKey, next.id);
    setProof(read(`quizcity.friend-proof:${accountId}:${next.id}`) ?? "");
    try {
      setAnswers(JSON.parse(read(`quizcity.friend-answers:${accountId}:${next.id}`) ?? "{}"));
    } catch {
      setAnswers({});
    }
  }
  useEffect(() => {
    active.current = true;
    let disposed = false;
    void api
      .quizMatches()
      .then(({ matches }) => {
        if (disposed) return;
        setRooms(matches);
        const selected =
          matches.find((m) => m.id === read(roomKey)) ??
          matches.find((m) => !["completed", "refunded"].includes(m.state));
        if (selected) choose(selected);
      })
      .catch((e) => {
        if (!disposed) setError(e instanceof Error ? e.message : "Could not load your matches.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      active.current = false;
    };
    // The component is keyed by account in the phone.
  }, [accountId]);
  useEffect(() => {
    if (!room || ["completed", "refunded"].includes(room.state) || !online) return;
    const id = room.id;
    let disposed = false,
      inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void api
        .quizMatch(id)
        .then(({ match }) => {
          if (!disposed && selection.current === id) {
            setRoom(match);
            if (["completed", "refunded"].includes(match.state)) onBalanceChanged();
          }
        })
        .catch(() => {
          /* Retain the last confirmed room while reconnecting. */
        })
        .finally(() => {
          inFlight = false;
        });
    }, 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [room?.id, room?.state, online, onBalanceChanged]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (loading || room || !online) return;
    let disposed = false,
      inFlight = false;
    const fetchRooms = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api.publicQuizRooms({
          ...(roomSearch ? { q: roomSearch } : {}),
          ...(stakeFilter ? { stake: stakeFilter } : {}),
        });
        if (!disposed) {
          setPublicRooms(result.rooms);
          setPublicError("");
        }
      } catch {
        if (!disposed)
          setPublicError("Could not refresh open rooms. We’ll keep checking while this screen is open.");
      } finally {
        inFlight = false;
        if (!disposed) setPublicLoading(false);
      }
    };
    setPublicLoading(true);
    void fetchRooms();
    const timer = window.setInterval(() => void fetchRooms(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loading, room?.id, online, roomSearch, stakeFilter]);
  async function run(label: string, work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setWorking(label);
    setError("");
    try {
      await work();
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error
            ? e.message
            : "Could not complete that action. Your saved payment will be checked.",
        );
    } finally {
      busy.current = false;
      if (active.current) setWorking(null);
    }
  }
  function requestId(intent: string) {
    const key = `quizcity.friend-request:${accountId}:${intent}`;
    let id = read(key);
    if (!id) {
      id = crypto.randomUUID();
      save(key, id);
    }
    return id;
  }
  const me = room?.participants.find((p) => p.accountId === accountId),
    locked = !!working || !online;
  const remaining = room?.endsAt ? Math.max(0, Math.ceil((Date.parse(room.endsAt) - clock) / 1000)) : 0;
  const attempted = !!room && !!read(`quizcity.friend-attempt:${accountId}:${room.id}`);
  return (
    <section className="friend-quiz" aria-label="Quiz opponents and rooms">
      <header>
        <span className="phone-eyebrow">NEAR KNOWLEDGE ARENA</span>
        <h3>Learn together. Play for the pot.</h3>
        <p>Two residents · five shared NEAR questions · two minutes. Highest score wins the quoted pot.</p>
      </header>
      {loading ? <LoadingStatus>Finding your quiz rooms…</LoadingStatus> : null}
      {working ? <LoadingStatus>{working}</LoadingStatus> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!room && !loading ? (
        <>
          <p>
            Visit the quiz centre to find an opponent, browse public rooms or invite a friend. Every round
            uses official NEAR learning sources. Searching never spends QC: once paired, each player confirms
            their own deposit.
          </p>
          <form
            className="phone-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run("Creating your room…", async () =>
                choose(
                  (
                    await api.createQuizMatch(
                      requestId(`create:${isPublic ? "public:" : ""}${stake}`),
                      stake,
                      ...(isPublic ? ["public" as const] : []),
                    )
                  ).match,
                ),
              );
            }}
          >
            <label>
              Your stake (QC)
              <input
                type="number"
                min="50"
                max="1000"
                step="50"
                required
                value={stake}
                onChange={(e) => setStake(e.target.value)}
              />
            </label>
            {/^[1-9][0-9]*$/.test(stake) &&
            BigInt(stake) >= 50n &&
            BigInt(stake) <= 1000n &&
            BigInt(stake) % 50n === 0n ? (
              <p className="match-fee-note">
                Deposit {stake} QC per player. The centre takes {(BigInt(stake) / 50n).toString()} QC (2%)
                from each stake; the winner receives {((BigInt(stake) - BigInt(stake) / 50n) * 2n).toString()}{" "}
                QC. Native NEAR gas is separate; no QC gas fee.
              </p>
            ) : null}
            <small>Stakes use 50 QC increments so the 2% fee stays exact in whole QC units.</small>
            <label className="match-publish">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              List this room publicly
            </label>
            <div className="match-actions">
              <button
                disabled={locked}
                type="button"
                onClick={() =>
                  void run("Finding an opponent…", async () =>
                    choose((await api.findQuizOpponent(requestId(`search:${stake}`), stake)).match),
                  )
                }
              >
                Find an opponent
              </button>
              <button disabled={locked}>{isPublic ? "Create public room" : "Create a friend room"}</button>
            </div>
          </form>
          <form
            className="phone-form"
            onSubmit={(e) => {
              e.preventDefault();
              const code = String(new FormData(e.currentTarget).get("code")).trim().toUpperCase();
              void run("Joining your friend…", async () =>
                choose((await api.joinQuizMatch(requestId(`join:${code}`), code)).match),
              );
            }}
          >
            <label>
              Friend's invite code
              <input
                name="code"
                minLength={10}
                maxLength={10}
                pattern="[A-Fa-f0-9]{10}"
                autoCapitalize="characters"
                autoComplete="off"
                required
              />
            </label>
            <button disabled={locked}>Join room</button>
          </form>
          <section aria-label="Open public rooms" className="match-browser">
            <h4>Open public rooms</h4>
            <p>Join someone new. Latest 20 available rooms; two players per round.</p>
            <label>
              Search by player
              <input value={roomSearch} maxLength={40} onChange={(e) => setRoomSearch(e.target.value)} />
            </label>
            <label>
              Filter by stake
              <select value={stakeFilter} onChange={(e) => setStakeFilter(e.target.value)}>
                <option value="">All stakes</option>
                {Array.from({ length: 20 }, (_, i) => (i + 1) * 50).map((n) => (
                  <option key={n} value={n}>
                    {n} QC
                  </option>
                ))}
              </select>
            </label>
            {publicLoading ? <LoadingStatus>Finding open rooms…</LoadingStatus> : null}
            {publicError ? <p role="status">{publicError}</p> : null}
            {!publicLoading && !publicRooms.length ? (
              <p>No open rooms match your search. Create a public room or choose Find an opponent.</p>
            ) : null}
            {publicRooms.map((r) => (
              <article className="city-list-item" key={r.id}>
                <strong>{r.host}'s room</strong>
                <p>
                  {formatQc(r.stake)} QC stake · {formatQc(r.prize)} QC winner’s pot · 2% centre fee deducted.
                </p>
                <button
                  disabled={locked}
                  onClick={() =>
                    void run("Joining the public room…", async () =>
                      choose((await api.joinPublicQuizRoom(r.id, requestId(`publicjoin:${r.id}`))).match),
                    )
                  }
                >
                  Join {r.host}
                </button>
              </article>
            ))}
          </section>
          {rooms.length ? (
            <details>
              <summary>Your recent matches</summary>
              {rooms.map((m) => (
                <button key={m.id} onClick={() => choose(m)}>
                  {m.code} · {m.state}
                </button>
              ))}
            </details>
          ) : null}
        </>
      ) : null}
      {room ? (
        <>
          <div className="match-ticket">
            <span>{room.visibility === "public" ? "Public quiz room" : "Private invite room"}</span>
            <strong className="match-code">{room.code}</strong>
            <p>
              Winner's pot <strong>{formatQc(room.prize)} QC</strong>
            </p>
            <dl>
              <dt>Your stake</dt>
              <dd>{formatQc(room.stake)} QC</dd>
              <dt>
                {room.feePolicy === "deducted-2-v2"
                  ? "Quiz centre · 2%, deducted from stake"
                  : "Saved centre fee · 5%, added to stake"}
              </dt>
              <dd>{formatQc(room.venueFee)} QC</dd>
              {room.gasSupportFee !== "0" ? (
                <>
                  <dt>Saved QC gas-support charge</dt>
                  <dd>{formatQc(room.gasSupportFee)} QC</dd>
                </>
              ) : null}
              <dt>Total per player</dt>
              <dd>{formatQc(room.totalDue)} QC</dd>
            </dl>
            <small>
              {room.feePolicy === "deducted-2-v2"
                ? "The 2% centre fee comes out of your stake only when someone wins. No QC gas-support charge."
                : "This older room keeps the fee terms shown when it was created."}{" "}
              Actual NEAR transaction fees are separate. A tie or cancelled lobby returns the entire deposited
              QC amount.
            </small>
          </div>
          <ul className="match-residents">
            {room.participants.map((p) => (
              <li key={p.accountId}>
                <strong>
                  {p.username}
                  {p.accountId === accountId ? " (you)" : ""}
                </strong>
                <span>
                  {p.score !== null
                    ? `${p.score}/5`
                    : p.submitted
                      ? "Answers locked"
                      : p.funded
                        ? "Stake confirmed"
                        : "Awaiting stake"}
                </span>
              </li>
            ))}
          </ul>
          {room.state === "waiting" && room.visibility === "public" && room.participants.length === 1 ? (
            <>
              <LoadingStatus>Searching for an opponent at {formatQc(room.stake)} QC…</LoadingStatus>
              <p>
                You can close the phone while searching. Stop searching cancels the lobby and arranges any
                full QC refund.
              </p>
            </>
          ) : null}
          {room.state === "waiting" && room.participants.length === 2 ? (
            <p className="match-fee-note">
              Opponent found! Both players must confirm their deposits before the countdown starts.
            </p>
          ) : null}
          {room.state === "waiting" && !me?.funded ? (
            <>
              <p>
                Your payment goes into contract escrow. The round starts automatically after both deposits are
                confirmed. Missing the submission deadline scores zero. Lobby expires{" "}
                {new Date(room.joinExpiresAt).toLocaleTimeString()}.
              </p>
              {!attempted && !room.operation.tx_hash ? (
                <button
                  disabled={locked || !send || (room.visibility === "public" && room.participants.length < 2)}
                  onClick={() =>
                    void run("Depositing your stake into escrow…", async () => {
                      if (!send) return;
                      save(`quizcity.friend-attempt:${accountId}:${room.id}`, "submitted");
                      const hash = await send(room.operation.method, room.operation.args);
                      save(`quizcity.friend-proof:${accountId}:${room.id}`, hash);
                      setProof(hash);
                      choose((await api.confirmQuizMatch(room.id, hash)).match);
                      onBalanceChanged();
                    })
                  }
                >
                  {working ? <Spinner /> : null}Deposit {formatQc(room.totalDue)} QC
                </button>
              ) : null}
            </>
          ) : null}
          {!me?.funded && (attempted || room.operation.tx_hash) ? (
            <div className="match-fee-note">
              <LoadingStatus>Checking your saved escrow payment…</LoadingStatus>
              <p>
                A delayed result does not start another payment. Managed wallet deposits are recovered
                automatically. If you used another wallet, paste its transaction hash to check it.
              </p>
              <form
                className="phone-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("Confirming your saved payment…", async () => {
                    choose((await api.confirmQuizMatch(room.id, proof || room.operation.tx_hash!)).match);
                    onBalanceChanged();
                  });
                }}
              >
                <label>
                  Transaction hash
                  <input
                    value={proof || room.operation.tx_hash || ""}
                    onChange={(e) => setProof(e.target.value)}
                    required
                    minLength={43}
                    maxLength={44}
                  />
                </label>
                <button disabled={locked}>Check this payment</button>
              </form>
            </div>
          ) : null}
          {room.state === "waiting" && me?.funded ? (
            <LoadingStatus>Waiting for your opponent's confirmed stake…</LoadingStatus>
          ) : null}
          {room.state === "countdown" ? (
            <p className="match-countdown" role="timer">
              Get ready · {Math.max(0, Math.ceil((Date.parse(room.startsAt!) - clock) / 1000))}
            </p>
          ) : null}
          {room.state === "playing" && !me?.submitted ? (
            <form
              aria-busy={!!working}
              onSubmit={(e) => {
                e.preventDefault();
                void run("Locking and scoring your answers…", async () =>
                  choose((await api.submitQuizMatch(room.id, answers)).match),
                );
              }}
            >
              <p role="timer">
                {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} remaining
              </p>
              {room.questions.map((q, i) => (
                <fieldset className="question" key={q.id} disabled={locked || remaining === 0}>
                  <legend>
                    {i + 1}. {q.question}
                  </legend>
                  {q.options.map((option, index) => (
                    <label className="option" key={index}>
                      <input
                        type="radio"
                        name={q.id}
                        checked={answers[q.id] === index}
                        onChange={() => {
                          const next = { ...answers, [q.id]: index };
                          setAnswers(next);
                          save(`quizcity.friend-answers:${accountId}:${room.id}`, JSON.stringify(next));
                        }}
                        required
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
              <button
                disabled={locked || remaining === 0 || Object.keys(answers).length !== room.questions.length}
              >
                Lock in answers
              </button>
              <p>
                Answers cannot be changed after submission. Unsubmitted players score zero when time runs out.
              </p>
            </form>
          ) : null}
          {room.state === "playing" && me?.submitted ? (
            <LoadingStatus>Answers locked. Waiting for the other player or the deadline…</LoadingStatus>
          ) : null}
          {room.outcome ? (
            <div className="match-result">
              <h4>
                {room.outcome === "win"
                  ? room.winnerAccount === accountId
                    ? "You won the round!"
                    : "Your opponent won this round"
                  : room.outcome === "tie"
                    ? "A draw — full QC refunds"
                    : "Lobby cancelled — full QC refunds"}
              </h4>
              {room.state === "settling" ? (
                <LoadingStatus>Confirming escrow payouts on NEAR…</LoadingStatus>
              ) : (
                <p>
                  {room.state === "completed"
                    ? "Prize and venue fees confirmed."
                    : "All confirmed deposits have been refunded."}
                </p>
              )}
              {room.transfers.filter((t) => ["unknown", "rejected"].includes(t.state)).length ? (
                <p>
                  Some transfers need further confirmation. Funds stay in escrow until a verified receipt is
                  available.
                </p>
              ) : null}
              {room.review.length ? (
                <details>
                  <summary>Review the NEAR lesson</summary>
                  {room.questions.map((q) => {
                    const review = room.review.find((r) => r.questionId === q.id);
                    return (
                      <article key={q.id}>
                        <strong>{q.question}</strong>
                        <p>{review?.explanation}</p>
                        <a href={q.source} target="_blank" rel="noreferrer">
                          Read the official NEAR source
                        </a>
                      </article>
                    );
                  })}
                </details>
              ) : null}
              <details>
                <summary>Payment confirmations</summary>
                {room.transfers.map((t, i) => (
                  <p key={i}>
                    {t.kind} · {formatQc(t.amount)} QC · {t.state}
                    {t.txHash ? <code className="match-hash">{t.txHash}</code> : null}
                  </p>
                ))}
              </details>
            </div>
          ) : null}
          {room.state === "waiting" ? (
            <button
              disabled={locked}
              onClick={() =>
                void run("Cancelling and arranging any refunds…", async () =>
                  choose((await api.cancelQuizMatch(room.id)).match),
                )
              }
            >
              {room.visibility === "public" && room.participants.length === 1
                ? "Stop searching"
                : "Cancel lobby"}
            </button>
          ) : null}
          {["completed", "refunded"].includes(room.state) ? (
            <button
              onClick={() => {
                selection.current = null;
                setRoom(null);
                save(roomKey, "");
                save(`quizcity.friend-request:${accountId}:create:${room.stake}`, "");
                save(`quizcity.friend-request:${accountId}:create:public:${room.stake}`, "");
                save(`quizcity.friend-request:${accountId}:search:${room.stake}`, "");
                save(`quizcity.friend-request:${accountId}:publicjoin:${room.id}`, "");
                save(`quizcity.friend-request:${accountId}:join:${room.code}`, "");
              }}
            >
              Back to friend rooms
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
