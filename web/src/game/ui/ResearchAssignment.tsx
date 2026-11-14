import { LoadingStatus, Spinner } from "../../components/LoadingStatus";
import { useEffect, useState } from "react";
import { api, type Job } from "../../api";
type Task = Awaited<ReturnType<typeof api.researchTask>>;
export function ResearchAssignment({
  jobId,
  accountId,
  disabled,
  onUpdated,
}: {
  jobId: string;
  accountId: string;
  disabled: boolean;
  onUpdated: (job: Job) => void;
}) {
  const draftKey = `quizcity.research-draft:${accountId}:${jobId}`;
  const readDraft = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
      return saved && typeof saved.summary === "string" && saved.answers
        ? saved
        : { answers: {}, summary: "" };
    } catch {
      return { answers: {}, summary: "" };
    }
  };
  const [task, setTask] = useState<Task | null>(null),
    [answers, setAnswers] = useState<Record<string, number>>(() => readDraft().answers),
    [summary, setSummary] = useState<string>(() => readDraft().summary),
    [error, setError] = useState<string | null>(null),
    [working, setWorking] = useState(false);
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ answers, summary }));
    } catch {
      /* Drafts are optional; submitted work is saved by the server. */
    }
  }, [draftKey, answers, summary]);
  useEffect(() => {
    let active = true;
    void api
      .researchTask(jobId)
      .then((t) => {
        if (active) setTask(t);
      })
      .catch(() => {
        if (active) setError("Could not load your saved assignment. Reopen the phone to retry.");
      });
    return () => {
      active = false;
    };
  }, [jobId]);
  if (!task)
    return error ? <p role="alert">{error}</p> : <LoadingStatus>Opening your assignment…</LoadingStatus>;
  return (
    <form
      className="phone-form"
      aria-busy={working}
      onSubmit={async (e) => {
        e.preventDefault();
        if (working) return;
        setWorking(true);
        setError(null);
        try {
          const result = await api.submitResearch(jobId, answers, summary);
          if (result.score === result.total) {
            try {
              sessionStorage.removeItem(draftKey);
            } catch {
              /* optional */
            }
            onUpdated(result.job);
          } else
            setError(`${result.score}/${result.total} correct. Revisit the reading before trying again.`);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not submit your research.");
        } finally {
          setWorking(false);
        }
      }}
    >
      <h4>{task.title}</h4>
      <p>{task.reading}</p>
      <a href={task.source} target="_blank" rel="noreferrer">
        Source: NEAR
      </a>
      {task.questions.map((q) => (
        <fieldset className="question" key={q.id}>
          <legend>{q.question}</legend>
          {q.options.map((option, i) => (
            <label className="option" key={i}>
              <input
                type="radio"
                name={`${jobId}-${q.id}`}
                required
                disabled={disabled || working}
                checked={answers[q.id] === i}
                onChange={() => setAnswers({ ...answers, [q.id]: i })}
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <label>
        Your research summary
        <textarea
          disabled={disabled || working}
          required
          minLength={20}
          maxLength={2000}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Explain what you learned in your own words…"
        />
      </label>
      <small>
        The knowledge check is verified automatically. Your summary is retained with the assignment. Payment
        is a separate confirmed step.
      </small>
      <button
        disabled={
          disabled ||
          working ||
          Object.keys(answers).length !== task.questions.length ||
          summary.trim().length < 20
        }
      >
        {working ? (
          <>
            <Spinner />
            Checking research…
          </>
        ) : (
          "Submit research"
        )}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
