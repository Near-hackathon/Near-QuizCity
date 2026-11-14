import { Spinner } from "../../components/LoadingStatus";
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { GameBridge } from "../bridge/GameBridge";
import { Modal } from "./Modal";
const questions = [
  {
    question: "What is NEAR Protocol?",
    options: [
      "A blockchain for building applications",
      "A city transport company",
      "A downloadable game engine",
    ],
    explanation: "NEAR provides blockchain infrastructure that applications can build on.",
  },
  {
    question: "What does NEAR Intents help people do?",
    options: [
      "Design building interiors",
      "Execute actions across different blockchains",
      "Choose a city username",
    ],
    explanation: "NEAR Intents supports cross-chain execution.",
  },
  {
    question: "Who should control your private wallet keys?",
    options: [
      "Anyone who knows your username",
      "A stranger offering free rewards",
      "You — keep them private",
    ],
    explanation: "Your keys control your wallet. Never share them in chat or with another player.",
  },
];
export function WelcomeGuide({
  accountId,
  online,
  bridge,
  onOpenPhone,
}: {
  accountId: string;
  online: boolean;
  bridge: GameBridge | null;
  onOpenPhone: () => void;
}) {
  const [open, setOpen] = useState(false),
    [step, setStep] = useState(0),
    [answers, setAnswers] = useState<number[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!online) return;
    void api
      .profiles()
      .then((r) => {
        if (active) setOpen(r.profiles.some((p) => p.accountId === accountId && !p.onboardingComplete));
      })
      .catch(() => {
        /* An optional tour never prevents reconnection. */
      });
    return () => {
      active = false;
    };
  }, [accountId, online]);
  useEffect(() => {
    if (open && online) bridge?.send({ type: "settingsChanged", settings: { uiModalOpen: true } });
    return () => {
      if (open) bridge?.send({ type: "settingsChanged", settings: { uiModalOpen: false } });
    };
  }, [open, online, bridge]);
  if (!open || !online) return null;
  const question = questions[step - 1];
  return (
    <Modal title="Welcome to the neighbourhood" onClose={() => setOpen(false)}>
      <div className="guide-avatar" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="58" height="58">
          <path d="M8 64V48c0-16 48-16 48 0v16" fill="#5d789a" />
          <path d="M27 34h10v13H27" fill="#dcb58e" />
          <ellipse cx="32" cy="24" rx="14" ry="17" fill="#e9bf97" />
          <path d="M17 23C13-2 52-2 47 23l-8-12-15 9Z" fill="#674a3f" />
          <path d="M25 27h1m12 0h1" stroke="#3b4142" strokeWidth="3" />
          <path d="M28 34q4 4 8 0" stroke="#9a5e4f" fill="none" />
        </svg>
      </div>
      <span className="city-eyebrow">ALEX · YOUR CITY GUIDE</span>
      {step === 0 ? (
        <>
          <h3>Hey, new neighbour!</h3>
          <p>
            This is your city. Walk with WASD or the arrows, click a path to stroll over, and press E when you
            meet someone.
          </p>
          <p>
            Your phone holds your jobs, quizzes, wallet and property. Let’s learn a little about NEAR, the
            network behind our city.
          </p>
          <button onClick={() => setStep(1)}>Show me around →</button>
        </>
      ) : step <= 3 ? (
        <>
          <p className="guide-progress">A little knowledge · {step} of 3</p>
          <h3>{question.question}</h3>
          <div className="guide-options">
            {question.options.map((option, index) => (
              <button
                aria-pressed={answers[step - 1] === index}
                key={option}
                onClick={() =>
                  setAnswers((prev) => {
                    const next = [...prev];
                    next[step - 1] = index;
                    return next;
                  })
                }
              >
                {option}
              </button>
            ))}
          </div>
          <p>No timer. No stakes. Just learning.</p>
          <button
            disabled={answers[step - 1] === undefined || busy}
            onClick={async () => {
              setError(null);
              if (step < 3) {
                setStep(step + 1);
                return;
              }
              setBusy(true);
              try {
                const result = await api.finishOnboarding(answers);
                if (result.complete) setStep(4);
                else {
                  setError("A few ideas to revisit. Read the tips below and have another go.");
                  setStep(1);
                }
              } catch {
                setError("Could not save your welcome tour. Please try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <>
                <Spinner />
                Saving…
              </>
            ) : step === 3 ? (
              "Finish my welcome"
            ) : (
              "Next →"
            )}
          </button>
          {error ? <p role="alert">{error}</p> : null}
          {error ? questions.map((q) => <p key={q.question}>{q.explanation}</p>) : null}
        </>
      ) : (
        <>
          <h3>You’re one of us now.</h3>
          <p>
            Visit the library for research, the quiz centre for a challenge, or the café to meet the
            neighbours. Your first chapter starts wherever you choose.
          </p>
          <button
            onClick={() => {
              setOpen(false);
              onOpenPhone();
            }}
          >
            Open my phone
          </button>
          <button onClick={() => setOpen(false)}>Let me explore</button>
        </>
      )}
      <p className="guide-source">
        Learn more from{" "}
        <a href="https://near.org/" target="_blank" rel="noreferrer">
          NEAR’s official website
        </a>
        . This welcome quiz does not issue QC.
      </p>
    </Modal>
  );
}
