import { LoadingStatus, Spinner } from "../../components/LoadingStatus";
import { ManagedWalletSetup } from "../../components/ManagedWalletSetup";
import { ManagedWalletBackup } from "../../components/ManagedWalletBackup";
import { CityServices } from "./CityServices";
import { isBrowserAccount } from "@quiz-city/protocol";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { api, ApiError, type Job, type Quiz, type Property, type Resident } from "../../api";
import { useAppState } from "../../state/StateProvider";
import type { WorldStatus } from "../../state/world-transport";
import type { GameBridge } from "../bridge/GameBridge";
import { Modal } from "./Modal";
import { loadPreferences } from "../settings/settings";
import type { WorldBootstrapType } from "@quiz-city/protocol";
import { WalletSetupError } from "../wallet-setup";
import { residentProfile } from "@quiz-city/world-data";
import { PropertyCard } from "../../components/CityGrid";
import { ShopsPanel } from "./ShopsPanel";
import { ResearchAssignment } from "./ResearchAssignment";
import { WelcomeGuide } from "./WelcomeGuide";
import { QuizPanel } from "../../components/JobsPanel";

const QuizMatches = lazy(() => import("./QuizMatches").then((m) => ({ default: m.QuizMatches })));

const tabs = ["Jobs", "Quizzes", "Wallet", "Property", "Business", "Settings", "Help", "Credits"] as const;
const phoneIcons: Record<(typeof tabs)[number], string> = {
  Jobs: "M4 8h16v12H4z M8 8V4h8v4 M4 12h16 M10 11v4h4v-4",
  Quizzes: "M5 3h14v18H5z M9 8c0-4 8-4 6 1l-3 3v2 M12 17v1",
  Wallet: "M3 6h17v14H3z M3 6l14-3v3 M15 11h6v5h-6z",
  Property: "M2 11 12 3l10 8 M5 9v12h14V9 M10 21v-7h4v7",
  Business:
    "M3 8h18l-2-5H5z M4 8v13h16V8 M3 8v3c0 3 5 3 5 0 0 3 4 3 4 0 0 3 4 3 4 0 0 3 5 3 5 0V8 M9 21v-6h6v6",
  Settings:
    "M12 4v3 M12 17v3 M4 12h3 M17 12h3 M6 6l2 2 M16 16l2 2 M6 18l2-2 M16 8l2-2 M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8",
  Help: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18 M9 8c0-4 7-3 6 0l-3 3v2 M12 16v1",
  Credits: "m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z",
};
const formatQc = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function GameUi({
  bridge,
  accountId,
  status,
  networkId,
  onSignOut,
  onSetupWallet,
  onReadWallet,
  onTransaction,
  onConnectWallet,
}: {
  bridge: GameBridge | null;
  accountId: string;
  status: WorldStatus;
  networkId: string;
  onSignOut: () => Promise<void>;
  onSetupWallet?: () => Promise<void>;
  onReadWallet?: () => Promise<string | null>;
  onTransaction?: (method: string, args: Record<string, unknown>) => Promise<string>;
  onConnectWallet?: () => Promise<void>;
}) {
  const { state, dispatch } = useAppState();
  const [deliverables, setDeliverables] = useState<Record<string, string>>({});
  const [resident, setResident] = useState<Resident | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .profiles()
      .then((r) => {
        if (active) setResident(r.profiles.find((p) => p.accountId === accountId) ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [accountId]);
  const displayName = resident?.username ?? (isBrowserAccount(accountId) ? "New neighbour" : accountId);
  const [balance, setBalance] = useState<string | null>(null);
  const [walletMissing, setWalletMissing] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const commandLock = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [location, setLocation] = useState("Connecting to city");
  const [menu, setMenu] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Jobs");
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [quizMode, setQuizMode] = useState<"practice" | "friends">("practice");
  const [selectedQuiz, setSelectedQuiz] = useState<Quiz | null>(null);
  const [candidate, setCandidate] = useState<{ id: string; label: string; available: boolean } | null>(null);
  const [dialogue, setDialogue] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; hash?: string } | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preferences, setPreferences] = useState(loadPreferences);
  const [npcDirectory, setNpcDirectory] = useState<NonNullable<WorldBootstrapType["npcDirectory"]>>([]);
  const seen = useRef(new Set<string>());
  const online = status === "online";
  const managedPending = resident?.walletKind === "embedded" && isBrowserAccount(accountId);
  const [managedStatus, setManagedStatus] = useState<Awaited<
    ReturnType<typeof api.managedWalletStatus>
  > | null>(null);
  const [managedStatusError, setManagedStatusError] = useState(false);
  useEffect(() => {
    if (!menu || !managedPending || !resident) return;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setManagedStatus(null);
    setManagedStatusError(false);
    const refreshStatus = async () => {
      try {
        const next = await api.managedWalletStatus(resident.id, { signal: controller.signal });
        if (!active) return;
        setManagedStatus(next);
        setManagedStatusError(false);
        if (next.stage === "ready") return;
      } catch {
        if (!active) return;
        setManagedStatusError(true);
      }
      if (active) timer = setTimeout(() => void refreshStatus(), 3000);
    };
    void refreshStatus();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [menu, managedPending, resident?.id, accountId]);
  const managedLabel =
    managedStatus?.errorCode === "CONTRACT_UPGRADE_REQUIRED"
      ? "QC pending · city contract update required"
      : managedStatus?.stage === "ready"
        ? "Finishing city sign-in"
        : managedStatus?.stage === "creating_account"
          ? "Creating your testnet account"
          : managedStatusError && !managedStatus
            ? "Wallet setup status unavailable · rechecking"
            : "Automatic wallet setup in progress";

  useEffect(() => {
    bridge?.send({
      type: "settingsChanged",
      settings: {
        reducedMotion: preferences.reducedMotion,
        zoom: preferences.zoom,
        interactKey: preferences.interactKey,
        uiModalOpen: menu || !!dialogue,
      },
    });
    try {
      localStorage.setItem("quizcity.game-settings.v1", JSON.stringify(preferences));
    } catch {
      /* Preferences are optional. */
    }
  }, [bridge, menu, dialogue, preferences]);

  useEffect(() => {
    if (!bridge) return;
    const off = bridge.subscribe((message) => {
      if (message.type === "transitionStatus") setTransitioning(message.pending);
      if (message.type === "interactionCandidateChanged")
        setCandidate(
          message.targetId
            ? {
                id: message.targetId,
                label: message.label ?? message.targetId,
                available: message.available !== false,
              }
            : null,
        );
      if (message.type === "sceneRendered") {
        setLocation(message.sceneId.replace(/-/g, " "));
        setCandidate(null);
        setDialogue(null);
      }
      if (message.type === "interactionCompleted") {
        if (["property", "business", "quiz"].includes(message.kind)) {
          setDialogue(null);
          setMenu(true);
          setTab(message.kind === "property" ? "Property" : message.kind === "quiz" ? "Quizzes" : "Business");
        } else setDialogue(message.targetId);
      }
    });
    const offEvents = bridge.onReact((message) => {
      if (message.type === "bootstrap") setNpcDirectory(message.bootstrap.npcDirectory ?? []);
      if (message.type !== "worldEvent") return;
      const event = message.event;
      if (
        ![
          "job.presentation_changed",
          "business.state_changed",
          "property.presentation_changed",
          "purchase.presentation_changed",
        ].includes(event.type)
      )
        return;
      if (seen.current.has(event.eventId)) return;
      seen.current.add(event.eventId);
      setRefresh((value) => value + 1);
      if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value!);
      if (event.type === "job.presentation_changed") {
        const labels: Record<string, string> = {
          payment_pending: "Payment pending confirmation",
          payment_unknown: "Payment outcome unknown — awaiting reconciliation",
          payment_failed: "Payment failed",
          paid: "Job payment confirmed",
        };
        setNotice({
          text: labels[event.payload.status] ?? `Job: ${event.payload.status.replace(/_/g, " ")}`,
          hash: event.payload.txHash ?? undefined,
        });
      } else if (event.type === "purchase.presentation_changed")
        setNotice({ text: `Purchase ${event.payload.status}` });
    });
    return () => {
      off();
      offEvents();
    };
  }, [bridge]);

  useEffect(() => {
    if (!online) return;
    let active = true;
    const abort = new AbortController();
    setError(false);
    void Promise.allSettled([
      isBrowserAccount(accountId)
        ? Promise.reject(new ApiError("Wallet not linked", 404, "NOT_FOUND"))
        : api.player(accountId),
      api.jobs({ signal: abort.signal }),
      api.properties({ signal: abort.signal }),
      api.businesses({ signal: abort.signal }),
      api.quizzes({ signal: abort.signal }),
    ]).then(
      async ([player, jobs, properties, businesses, quizList]) => {
        if (!active) return;
        const unregistered =
          player.status === "rejected" &&
          player.reason instanceof ApiError &&
          player.reason.status === 404 &&
          player.reason.code === "NOT_FOUND";
        let confirmedBalance = player.status === "fulfilled" ? (player.value.wallet?.balance ?? null) : null;
        let missing = unregistered;
        let walletFailed = player.status === "rejected" && !unregistered;
        // Keep the last confirmed value visible while resolving a missing mirror.
        // Never publish the intermediate null between the API and chain responses.
        if (onReadWallet && (unregistered || (player.status === "fulfilled" && !player.value.wallet))) {
          try {
            confirmedBalance = await onReadWallet();
            missing = confirmedBalance === null;
          } catch {
            walletFailed = true;
          }
        }
        if (!active) return;
        if (!walletFailed) {
          setWalletMissing(missing);
          if (confirmedBalance !== null || missing) setBalance(confirmedBalance);
        }
        if (jobs.status === "fulfilled") dispatch({ type: "jobs", items: jobs.value });
        if (properties.status === "fulfilled") dispatch({ type: "properties", items: properties.value });
        if (businesses.status === "fulfilled") dispatch({ type: "businesses", items: businesses.value });
        if (quizList.status === "fulfilled") setQuizzes(quizList.value);
        setError(
          walletFailed ||
            [jobs, properties, businesses, quizList].some((result) => result.status === "rejected"),
        );
      },
      () => {
        if (active) setError(true);
      },
    );
    const timer = window.setInterval(() => {
      if (!document.hidden) setRefresh((value) => value + 1);
    }, 20_000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, [accountId, dispatch, online, refresh, onReadWallet]);
  const jobs = state.lists.jobIds.map((id) => state.entities.jobs[id]);
  const activeJob = jobs.find(
    (job) => job.employee_account === accountId && !["paid", "cancelled"].includes(job.status),
  );
  async function runAction(id: string, action: () => Promise<unknown>, success: string) {
    if (commandLock.current || !online) return;
    commandLock.current = true;
    setWorking(id);
    setActionError(null);
    try {
      await action();
      setNotice({ text: success });
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(
        cause instanceof ApiError || cause instanceof WalletSetupError
          ? cause.message
          : id === "wallet"
            ? "Wallet setup could not be confirmed. If you refreshed or changed accounts, sign out and sign in again before retrying."
            : "The action could not be confirmed. Please try again.",
      );
      setRefresh((value) => value + 1);
    } finally {
      commandLock.current = false;
      setWorking(null);
    }
  }
  async function transact(
    method: string,
    args: Record<string, unknown>,
    confirm: (hash: string) => Promise<unknown>,
  ) {
    if (!onTransaction) throw new WalletSetupError("Connect your wallet to continue.");
    const hash = await onTransaction(method, args);
    await confirm(hash);
  }
  const buyProperty = (p: Property) =>
    void runAction(
      `plot:${p.id}`,
      () => transact("buy_property", { property_id: Number(p.id) }, (hash) => api.buyProperty(p.id, hash)),
      "Purchase confirmed. Your plot is ready.",
    );
  const openBusiness = (p: Property, name: string) =>
    void runAction(
      `plot:${p.id}`,
      () =>
        transact("create_business", { property_id: Number(p.id), name }, (hash) =>
          api.createBusiness(p.id, name, hash),
        ),
      "Your business is open!",
    );
  const jobRow = (job: Job) => (
    <article key={job.id} className="city-list-item">
      <strong>{job.title}</strong>
      <p>{job.description}</p>
      <span>
        {formatQc(job.payment)} QC · {job.status.replace(/_/g, " ")}
      </span>
      {job.status === "open" ? (
        <button
          disabled={!online || working !== null}
          onClick={() =>
            void runAction(
              job.id,
              async () => {
                const accepted = await api.acceptJob(job.id);
                dispatch({
                  type: "jobs",
                  items: jobs.map((item) => (item.id === accepted.id ? accepted : item)),
                });
              },
              "Job accepted. Find it under Active job.",
            )
          }
        >
          {working === job.id ? "Accepting…" : "Accept job"}
        </button>
      ) : null}
      {job.employee_account === accountId ? <p>Assigned to you</p> : null}
      {job.employee_account === accountId && job.status === "accepted" && !job.has_research_task ? (
        <form
          className="phone-form"
          onSubmit={(e) => {
            e.preventDefault();
            void runAction(
              job.id,
              () => api.submitJob(job.id, deliverables[job.id].trim()),
              "Work submitted for review. Your progress is saved.",
            );
          }}
        >
          <label>
            Your deliverable
            <textarea
              required
              minLength={10}
              maxLength={4000}
              value={deliverables[job.id] ?? ""}
              onChange={(e) => setDeliverables({ ...deliverables, [job.id]: e.target.value })}
              placeholder="Write your findings here…"
            />
          </label>
          <button disabled={working !== null || !online || !(deliverables[job.id]?.trim().length >= 10)}>
            Submit work
          </button>
        </form>
      ) : null}
      {job.employee_account === accountId && job.status === "accepted" && job.has_research_task ? (
        <ResearchAssignment
          accountId={accountId}
          jobId={job.id}
          disabled={!online}
          onUpdated={(updated) => {
            dispatch({ type: "jobs", items: jobs.map((j) => (j.id === updated.id ? updated : j)) });
            setRefresh((v) => v + 1);
          }}
        />
      ) : null}
      {job.employee_account === accountId && job.status === "submitted" ? (
        <p>Under review. Your employer must verify your work before payment.</p>
      ) : null}
      {job.employee_account === accountId && job.status === "verified" ? (
        <button
          disabled={working !== null || !online}
          onClick={() =>
            void runAction(
              job.id,
              () => api.completeJob(job.id),
              "Payment requested. Your wallet updates after confirmation.",
            )
          }
        >
          Collect payment
        </button>
      ) : null}
      {job.employee_account === accountId && ["payment_pending", "payment_unknown"].includes(job.status) ? (
        <p>Confirming your payment. Your saved reference prevents a second payout.</p>
      ) : null}
    </article>
  );
  return (
    <>
      <button className="city-phone-launcher" aria-label="Open city phone" onClick={() => setMenu(true)}>
        <svg viewBox="0 0 48 76" aria-hidden="true">
          <rect x="3" y="2" width="42" height="72" rx="11" fill="#253b50" stroke="#f7f6e6" strokeWidth="2" />
          <rect x="7" y="7" width="34" height="61" rx="7" fill="#d9eab4" />
          <path d="M18 8h12" stroke="#253b50" strokeWidth="4" strokeLinecap="round" />
          <path d="m24 23 9 15-9 15-9-15Z" fill="#70a283" />
          <path d="M19 63h10" stroke="#263d51" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>Phone</span>
      </button>
      <WelcomeGuide
        accountId={accountId}
        online={online}
        bridge={bridge}
        onOpenPhone={() => {
          setTab("Help");
          setMenu(true);
        }}
      />
      <div className="city-location">
        <span className={online ? "city-online" : "city-offline"}>●</span> {location}
        <span role="status">{status}</span>
      </div>
      {activeJob ? (
        <aside className="city-job">
          <span className="city-eyebrow">ACTIVE JOB</span>
          <strong>{activeJob.title}</strong>
          <span>{activeJob.status.replace(/_/g, " ")}</span>
        </aside>
      ) : null}
      {transitioning ? (
        <p className="city-interaction" role="status">
          Entering building…
        </p>
      ) : null}
      {candidate && online && !menu && !dialogue && !transitioning ? (
        candidate.available ? (
          <button className="city-interaction" onClick={() => bridge?.send({ type: "activateInteraction" })}>
            <kbd>{preferences.interactKey === "Space" ? "Space" : "E"}</kbd> Visit {candidate.label}
          </button>
        ) : (
          <p className="city-interaction" role="status">
            Closed: {candidate.label}
          </p>
        )
      ) : null}
      <p className="city-controls">WASD / arrows to walk · Click to move · E to interact · Phone for help</p>
      {error ? (
        <p className="city-notice" role="alert">
          Management data could not refresh.{" "}
          <button onClick={() => setRefresh((value) => value + 1)}>Retry</button>{" "}
          <button
            onClick={() => {
              setMenu(true);
              setTab("Help");
            }}
          >
            Open phone
          </button>
        </p>
      ) : null}
      {notice ? (
        <div className="city-notice" role="status">
          {notice.text}{" "}
          {notice.hash ? (
            <button
              onClick={() => {
                setMenu(true);
                setTab("Wallet");
              }}
            >
              View receipt
            </button>
          ) : null}
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice">
            ✕
          </button>
        </div>
      ) : null}
      {dialogue ? (
        <Modal
          title={residentProfile(dialogue)?.name ?? dialogue.replace(/[-_]/g, " ")}
          onClose={() => setDialogue(null)}
        >
          {residentProfile(dialogue) ? <p>{residentProfile(dialogue)!.role}</p> : null}
          <p>
            {residentProfile(dialogue)?.greeting ??
              "Welcome. You can inspect current opportunities and manage your activities from your phone."}
          </p>
          <button
            onClick={() => {
              const action = residentProfile(dialogue)?.action;
              setDialogue(null);
              setMenu(true);
              setTab(
                action === "quiz"
                  ? "Quizzes"
                  : action === "business"
                    ? "Business"
                    : action === "residents"
                      ? "Help"
                      : "Jobs",
              );
            }}
          >
            {residentProfile(dialogue)?.action === "quiz"
              ? "Choose a quiz"
              : residentProfile(dialogue)?.action === "business"
                ? "View businesses"
                : residentProfile(dialogue)?.action === "residents"
                  ? "Find residents"
                  : residentProfile(dialogue)?.action === "research"
                    ? "Browse research jobs"
                    : "View city opportunities"}
          </button>
        </Modal>
      ) : null}
      {menu ? (
        <Modal title="Your city phone" variant="phone" onClose={() => setMenu(false)}>
          <div className="phone-island" aria-hidden="true" />
          <div className="phone-wallpaper">
            <span className="city-eyebrow">YOUR LITTLE CITY, IN YOUR POCKET</span>
            <h3>Hello, {resident?.firstName ?? "neighbour"}.</h3>
            <div className="phone-balance">
              <span>City wallet</span>
              <strong>
                {balance === null ? "—" : formatQc(balance)} <small>QC</small>
              </strong>
              <span>
                {managedPending
                  ? managedLabel
                  : walletMissing
                    ? "Connect your city wallet"
                    : online
                      ? "Confirmed balance"
                      : "Last confirmed · offline"}
              </span>
              {managedPending ? (
                <>
                  {managedStatus?.accountId ? (
                    <code className="phone-receipt">{managedStatus.accountId}</code>
                  ) : null}
                  <button onClick={() => setTab("Wallet")}>View wallet setup</button>
                </>
              ) : null}
            </div>
          </div>
          <nav aria-label="Phone sections" className="city-tabs">
            {tabs.map((name) => (
              <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
                <span className="phone-app-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d={phoneIcons[name]} />
                  </svg>
                </span>
                {name}
              </button>
            ))}
          </nav>
          <section aria-label={tab}>
            {working ? <LoadingStatus>Processing your request…</LoadingStatus> : null}
            {actionError ? <p role="alert">{actionError}</p> : null}
            {tab === "Jobs" ? (
              <>{jobs.length ? jobs.map(jobRow) : <p>No jobs are currently available.</p>}</>
            ) : null}
            {tab === "Quizzes" ? (
              <>
                <div className="city-quiz-modes">
                  <button aria-pressed={quizMode === "practice"} onClick={() => setQuizMode("practice")}>
                    NEAR practice
                  </button>
                  <button aria-pressed={quizMode === "friends"} onClick={() => setQuizMode("friends")}>
                    Compete
                  </button>
                </div>
                {quizMode === "friends" ? (
                  <Suspense fallback={<LoadingStatus>Opening the NEAR arena…</LoadingStatus>}>
                    <QuizMatches
                      key={accountId}
                      accountId={accountId}
                      online={online}
                      send={onTransaction}
                      onBalanceChanged={() => setRefresh((v) => v + 1)}
                    />
                  </Suspense>
                ) : selectedQuiz ? (
                  <>
                    <QuizPanel
                      key={selectedQuiz.id}
                      storageKey={`quizcity.quiz:${accountId}:${selectedQuiz.id}`}
                      inlineReceipts
                      title={selectedQuiz.title}
                      introduction="Answers and rewards are verified by the server. Daily limits and available prize funds apply."
                      me={online ? accountId : null}
                      busy={!online}
                      start={() => api.startQuiz(selectedQuiz.id)}
                      submit={async (attemptId, answers) => {
                        const result = await api.submitQuiz(selectedQuiz.id, attemptId, answers);
                        setRefresh((value) => value + 1);
                        return result;
                      }}
                    />
                    <button onClick={() => setSelectedQuiz(null)}>Back to quizzes</button>
                  </>
                ) : quizzes.length ? (
                  quizzes.map((quiz) => (
                    <article key={quiz.id} className="city-list-item">
                      <strong>{quiz.title}</strong>
                      <p>
                        {quiz.questions} questions · {quiz.status.replace(/_/g, " ")}
                      </p>
                      {quiz.entry_fee === "0" ? (
                        <button
                          disabled={!online || quiz.status !== "live"}
                          onClick={() => setSelectedQuiz(quiz)}
                        >
                          Choose quiz
                        </button>
                      ) : (
                        <button
                          disabled={!online || working !== null || quiz.status !== "live"}
                          onClick={() =>
                            void runAction(
                              `admission:${quiz.id}`,
                              async () => {
                                const { operation } = await api.cityCommand({
                                  requestId: crypto.randomUUID(),
                                  action: "admission",
                                  targetId: quiz.id,
                                });
                                if (operation.status !== "confirmed") {
                                  if (!onTransaction) throw Error("Connect your wallet first.");
                                  const hash =
                                    operation.tx_hash ??
                                    (await onTransaction(operation.method, operation.args));
                                  await api.cityConfirm(operation.id, hash);
                                }
                                setSelectedQuiz(quiz);
                              },
                              "Admission confirmed.",
                            )
                          }
                        >
                          Pay admission · {formatQc(quiz.entry_fee)} QC
                        </button>
                      )}
                      {quiz.draft_id ? (
                        <details>
                          <summary>Support or report this quiz</summary>
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              const f = new FormData(event.currentTarget);
                              void runAction(
                                `sponsor:${quiz.id}`,
                                async () => {
                                  if (!onTransaction) throw Error("Connect your wallet first.");
                                  const { operation } = await api.cityCommand({
                                    requestId: crypto.randomUUID(),
                                    action: "sponsor",
                                    targetId: quiz.id,
                                    amount: String(f.get("amount")),
                                  });
                                  const hash =
                                    operation.tx_hash ??
                                    (await onTransaction(operation.method, operation.args));
                                  await api.cityConfirm(operation.id, hash);
                                },
                                "Sponsorship confirmed. The prize funds are reserved.",
                              );
                            }}
                          >
                            <label>
                              Sponsor prizes (QC)
                              <input name="amount" type="number" min="1" max="10000" required />
                            </label>
                            <button disabled={!online || working !== null}>Sponsor prize pool</button>
                          </form>
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              const f = new FormData(event.currentTarget);
                              void runAction(
                                `report:${quiz.id}`,
                                async () => {
                                  await api.reportQuiz(quiz.draft_id!, String(f.get("reason")));
                                },
                                "Your report was sent to the moderators.",
                              );
                            }}
                          >
                            <label>
                              Report a question or source
                              <textarea name="reason" minLength={10} maxLength={500} required />
                            </label>
                            <button disabled={!online || working !== null}>Submit report</button>
                          </form>
                        </details>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <p>No quizzes are currently available.</p>
                )}
              </>
            ) : null}
            {tab === "Wallet" ? (
              <>
                {resident?.walletKind === "embedded" && isBrowserAccount(accountId) ? (
                  <ManagedWalletSetup profile={resident} onReady={() => setRefresh((v) => v + 1)} />
                ) : null}
                <h3>{managedPending ? "Wallet balance" : "Confirmed wallet"}</h3>
                <p>
                  {managedPending
                    ? "Your wallet is being set up automatically. No manual wallet connection is needed."
                    : walletMissing
                      ? "You are signed in. QC registration has not been confirmed here yet."
                      : balance === null
                        ? "Balance unavailable"
                        : `${formatQc(balance)} QC`}
                </p>
                {walletMissing ? <p>You can explore the city without a registered QC account.</p> : null}
                {onSetupWallet &&
                resident?.walletKind !== "embedded" &&
                (walletMissing || balance === "0") ? (
                  <>
                    <p>
                      Register your QC wallet and claim your one-time 500 QC starter allowance. Your wallet
                      will ask you to approve the transactions.
                    </p>
                    <button
                      disabled={!online || working !== null}
                      onClick={() =>
                        void runAction(
                          "wallet",
                          onSetupWallet,
                          "Wallet setup confirmed. Refreshing your balance.",
                        )
                      }
                    >
                      {working === "wallet" ? "Setting up wallet…" : "Set up QC wallet / claim starter"}
                    </button>
                  </>
                ) : null}
                <p>{displayName}</p>
                {notice?.hash ? (
                  <details>
                    <summary>Latest transaction receipt</summary>
                    <code className="phone-receipt">{notice.hash}</code>
                    <p>{networkId} · confirmed facts are reflected in your wallet above.</p>
                  </details>
                ) : null}
                <p>Pending or unknown payments do not increase your confirmed balance.</p>
                {resident ? <ManagedWalletBackup profile={resident} /> : null}
                {onConnectWallet && resident?.walletKind !== "embedded" ? (
                  <button
                    disabled={working !== null}
                    onClick={() => void runAction("connect", onConnectWallet, "Wallet connected.")}
                  >
                    Connect or recover wallet
                  </button>
                ) : null}
              </>
            ) : null}
            {tab === "Property" ? (
              <>
                {!state.lists.propertyIds.length ? (
                  <p>No plots are listed right now. Check back soon.</p>
                ) : null}
                {state.lists.propertyIds.map((id) => (
                  <PropertyCard
                    key={id}
                    property={state.entities.properties[id]}
                    business={state.lists.businessIds
                      .map((b) => state.entities.businesses[b])
                      .find((b) => b.property_id === id)}
                    me={accountId}
                    busy={!online || working !== null}
                    onBuy={buyProperty}
                    onOpenBusiness={openBusiness}
                  />
                ))}
              </>
            ) : null}
            {tab === "Business" ? (
              <>
                <ShopsPanel
                  businesses={state.lists.businessIds.map((id) => state.entities.businesses[id])}
                  accountId={accountId}
                  online={online}
                  send={onTransaction}
                  onChanged={() => setRefresh((v) => v + 1)}
                />
                <CityServices
                  accountId={accountId}
                  send={onTransaction}
                  onChanged={() => setRefresh((v) => v + 1)}
                />
              </>
            ) : null}
            {tab === "Settings" ? (
              <div className="city-settings">
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.reducedMotion}
                    onChange={(event) =>
                      setPreferences({ ...preferences, reducedMotion: event.target.checked })
                    }
                  />{" "}
                  Reduced motion
                </label>
                <label>
                  Pixel scale{" "}
                  <select
                    value={preferences.zoom}
                    onChange={(event) => setPreferences({ ...preferences, zoom: Number(event.target.value) })}
                  >
                    {[1, 2, 3].map((scale) => (
                      <option key={scale} value={scale}>
                        {scale}×
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Interact key{" "}
                  <select
                    value={preferences.interactKey}
                    onChange={(event) => setPreferences({ ...preferences, interactKey: event.target.value })}
                  >
                    <option value="KeyE">E</option>
                    <option value="Space">Space</option>
                  </select>
                </label>
                <label>
                  Effects volume{" "}
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={preferences.volume}
                    onChange={(event) =>
                      setPreferences({ ...preferences, volume: Number(event.target.value) })
                    }
                  />
                </label>
                <p>The city is quiet for now. Audio is coming soon.</p>
              </div>
            ) : null}
            {tab === "Help" ? (
              <>
                <h3>Explore at your own pace</h3>
                <h4>Find the residents</h4>
                {npcDirectory.length ? (
                  npcDirectory.map((npc) => (
                    <p key={npc.npcId}>
                      {residentProfile(npc.npcId)?.name ?? npc.npcId.replace(/-/g, " ")}
                      {residentProfile(npc.npcId) ? ` (${residentProfile(npc.npcId)!.role})` : ""}:{" "}
                      {npc.sceneId.replace(/-/g, " ")} · {npc.activity.replace(/_/g, " ")} (at the last city
                      update)
                    </p>
                  ))
                ) : (
                  <p>Resident locations will appear after the city connects.</p>
                )}
                <p>
                  Library: 08:00–20:00. University: 07:00–21:00. Quiz centre: 09:00–22:00. Café: 06:00–23:00.
                  Times follow the local city clock. The apartment entrance is always available.
                </p>
                <p>
                  Walk with WASD or the arrow keys. Click a reachable tile to walk there. Click an entrance
                  circle to walk over and enter, or approach and press your interact key. Entry happens only
                  after the server accepts your visit.
                </p>
                <p>
                  Tab moves through menus. Escape closes this phone. All city activities stay inside your
                  phone.
                </p>
              </>
            ) : null}
            {tab === "Credits" ? (
              <>
                <h3>City artwork</h3>
                <p>
                  <a href="https://gridwrightstudio.itch.io" target="_blank" rel="noreferrer noopener">
                    Art by Gridwright
                  </a>
                </p>
                <p>
                  Gridwright City, Interiors and City People. Original Quiz City world and interface.
                </p>
                <p>
                  Additional campus buildings and furniture supplied by the project owner. See asset notices
                  for permission records.
                </p>
                <a
                  href="/game-assets/runtime/THIRD_PARTY_NOTICES.txt"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Third-party notices
                </a>
              </>
            ) : null}
          </section>
          <footer className="city-phone-footer">
            <span>{displayName}</span>
            <button
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                setSignOutError(false);
                try {
                  await onSignOut();
                } catch {
                  setSignOutError(true);
                  setSigningOut(false);
                }
              }}
            >
              {signingOut ? (
                <>
                  <Spinner />
                  Signing out…
                </>
              ) : (
                "Sign out"
              )}
            </button>
          </footer>
          {signOutError ? <p role="alert">Could not sign out. Please try again.</p> : null}
        </Modal>
      ) : null}
    </>
  );
}
