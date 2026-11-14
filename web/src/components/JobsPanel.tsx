import { LoadingStatus, Spinner } from "./LoadingStatus";
import { useEffect, useState } from "react";
import type { Job } from "../api";
import { money, short } from "./CityGrid";

type Props = {
  jobs: Job[];
  me: string | null;
  busy: boolean;
  onAccept: (job: Job) => void;
  onComplete: (job: Job) => void;
};

export function JobsPanel({ jobs, me, busy, onAccept, onComplete }: Props) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Jobs</h2>
        <span className="muted">NPC contracts</span>
      </div>
      <div className="stack">
        {jobs.length === 0 && <p className="muted">No jobs posted.</p>}
        {jobs.map((job) => {
          const mine = job.employee_account === me;
          return (
            <article key={job.id} className="job">
              <div className="card-head">
                <strong>{job.title}</strong>
                <span className={`pill status-${job.status}`}>{job.status}</span>
              </div>
              <p className="muted">{job.description}</p>
              <div className="row space">
                <span className="mono">{short(job.employer_wallet)}</span>
                <strong>{money(job.payment)} QC</strong>
              </div>
              <div className="row">
                {job.status === "open" && (
                  <button className="btn" disabled={busy || !me} onClick={() => onAccept(job)}>
                    Accept job
                  </button>
                )}
                {mine && job.status === "accepted" && (
                  <button className="btn primary" disabled={busy} onClick={() => onComplete(job)}>
                    Submit work
                  </button>
                )}
                {job.status === "submitted" && <span className="muted">Awaiting operator verification</span>}
                {mine && job.status === "verified" && (
                  <button className="btn primary" disabled={busy} onClick={() => onComplete(job)}>
                    Get paid
                  </button>
                )}
                {mine && job.status === "payment_failed" && (
                  <button className="btn" disabled={busy} onClick={() => onComplete(job)}>
                    Reconcile payment
                  </button>
                )}
                {job.status === "paid" && job.chain_tx && (
                  <a
                    className="link"
                    href={`https://testnet.nearblocks.io/txns/${job.chain_tx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    reward tx
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type QuizProps = {
  storageKey?: string;
  inlineReceipts?: boolean;
  title?: string;
  introduction?: string;
  me: string | null;
  busy: boolean;
  start: () => Promise<{
    attemptId: string;
    expiresAt?: string;
    passScore?: number;
    rewardAmount?: string;
    questions: { id: string; question: string; options: string[]; category: string | null }[];
  }>;
  submit: (
    attemptId: string,
    answers: Record<string, number>,
  ) => Promise<{ score: number; total: number; reward: string; txHash: string | null; status?: string }>;
};

export function QuizPanel({
  me,
  busy,
  start,
  submit,
  title,
  introduction,
  inlineReceipts,
  storageKey,
}: QuizProps) {
  const loadDraft = () => {
    try {
      const stored = storageKey ? JSON.parse(sessionStorage.getItem(storageKey) ?? "null") : null;
      if (
        stored?.attempt?.expiresAt &&
        new Date(stored.attempt.expiresAt).getTime() > Date.now() &&
        Array.isArray(stored.attempt.questions) &&
        stored.attempt.questions.length <= 100
      )
        return stored;
    } catch {
      /* Optional draft storage. */
    }
    return null;
  };
  const [attempt, setAttempt] = useState<Awaited<ReturnType<QuizProps["start"]>> | null>(
    () => loadDraft()?.attempt ?? null,
  );
  const [answers, setAnswers] = useState<Record<string, number>>(() => loadDraft()?.answers ?? {});
  const [result, setResult] = useState<Awaited<ReturnType<QuizProps["submit"]>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!attempt?.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [attempt?.expiresAt]);
  useEffect(() => {
    if (!storageKey) return;
    try {
      if (attempt) sessionStorage.setItem(storageKey, JSON.stringify({ attempt, answers }));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The server remains authoritative when storage is unavailable. */
    }
  }, [storageKey, attempt, answers]);
  const remaining = attempt?.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(attempt.expiresAt) - now) / 1000))
    : null;
  const expired = remaining === 0;

  async function begin() {
    setWorking(true);
    setError(null);
    setResult(null);
    setAnswers({});
    try {
      setAttempt(await start());
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not start quiz");
    } finally {
      setWorking(false);
    }
  }

  async function finish() {
    if (!attempt) return;
    setWorking(true);
    setError(null);
    try {
      setResult(await submit(attempt.attemptId, answers));
      setAttempt(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not submit quiz");
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working || !me;

  return (
    <section className="card">
      <div className="card-head">
        <h2>{title ?? "Daily Knowledge Round"}</h2>
        {!title && <span className="muted">8 questions · 25 QC</span>}
      </div>

      {!attempt && !result && (
        <>
          <p className="muted">
            {introduction ??
              "Answers are scored on the server. Pass mark: 6/8. One rewarded attempt per day."}
          </p>
          <button className="btn primary" disabled={disabled} onClick={begin}>
            {working ? (
              <>
                <Spinner />
                Opening quiz…
              </>
            ) : me ? (
              "Start quiz"
            ) : (
              "Sign in to play"
            )}
          </button>
        </>
      )}

      {attempt && (
        <div className="stack">
          <p>
            {Object.keys(answers).length}/{attempt.questions.length} answered
            {attempt.passScore ? ` · Pass mark ${attempt.passScore}` : ""}
          </p>
          <progress
            value={Object.keys(answers).length}
            max={attempt.questions.length}
            aria-label="Questions answered"
          />
          {remaining !== null ? (
            <p role="timer" aria-label="Time remaining">
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
            </p>
          ) : null}
          {expired ? <p>Time’s up. Finish to see your saved outcome.</p> : null}
          {attempt.questions.map((question, index) => (
            <fieldset key={question.id} className="question">
              <legend>
                {index + 1}. {question.question}
              </legend>
              {question.options.map((option, optionIndex) => (
                <label key={option} className="option">
                  <input
                    type="radio"
                    disabled={disabled || expired}
                    name={question.id}
                    checked={answers[question.id] === optionIndex}
                    onChange={() => setAnswers((prev) => ({ ...prev, [question.id]: optionIndex }))}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <button
            className="btn primary"
            disabled={disabled || (!expired && Object.keys(answers).length < attempt.questions.length)}
            onClick={finish}
          >
            {working ? (
              <>
                <Spinner />
                Scoring...
              </>
            ) : expired ? (
              "Finish expired attempt"
            ) : (
              "Submit answers"
            )}
          </button>
        </div>
      )}

      {result && (
        <div className="result">
          <strong>
            {result.score}/{result.total} correct
          </strong>
          {result.status === "reward_pending" ? (
            <LoadingStatus>
              Reward pending confirmation. Your confirmed balance has not increased.
            </LoadingStatus>
          ) : (
            <p>
              {result.status === "expired"
                ? "This attempt expired. No reward was issued."
                : result.status === "reward_pending"
                  ? "Reward pending confirmation. Your confirmed balance has not increased."
                  : BigInt(result.reward) > 0n
                    ? `Reward: ${money(result.reward)} QC`
                    : "No reward this attempt (pass mark or daily limit)."}
            </p>
          )}
          {result.txHash && inlineReceipts ? (
            <code className="phone-receipt">{result.txHash}</code>
          ) : result.txHash ? (
            <a
              className="link"
              href={`https://testnet.nearblocks.io/txns/${result.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              reward transaction
            </a>
          ) : null}
          <button className="btn ghost" onClick={() => setResult(null)}>
            Play again
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
