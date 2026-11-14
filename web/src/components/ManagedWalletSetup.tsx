import { ManagedWalletBrief } from "./ManagedWalletBrief";
import { useEffect, useRef, useState } from "react";
import { api, type Resident } from "../api";
import type { ManagedWalletStatus } from "@quiz-city/protocol";
import type { Static } from "@sinclair/typebox";
type Status = Static<typeof ManagedWalletStatus>;
const steps = [
  "Create your NEAR testnet account",
  "Register your city resident",
  "Confirm your 500 QC starter allowance",
];
export function ManagedWalletSetup({
  profile,
  onReady,
  onExplore,
}: {
  profile: Resident;
  onReady: (profile: Resident) => void | Promise<void>;
  onExplore?: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [retrying, setRetrying] = useState(false);
  const ready = useRef(false),
    callback = useRef(onReady);
  callback.current = onReady;
  useEffect(() => {
    ready.current = false;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api.managedWalletStatus(profile.id, { signal: controller.signal });
        if (!active) return;
        setStatus(next);
        setError("");
        if (next.stage === "ready" && !ready.current) {
          ready.current = true;
          let entered;
          try {
            entered = await api.enterProfile(profile.id);
          } catch (error) {
            ready.current = false;
            throw error;
          }
          if (active) await callback.current(entered.profile);
          return;
        }
        if (next.stage === "not_requested") return;
      } catch {
        ready.current = false;
        if (active) setError("Account setup could not refresh. Your saved account has been kept.");
      }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [profile.id]);
  const current =
    status?.stage === "registering"
      ? 1
      : status?.stage === "claiming"
        ? 2
        : status?.stage === "ready"
          ? 3
          : 0;
  return (
    <section className="managed-wallet-setup" aria-label="Your account setup">
      <ManagedWalletBrief status={status} unavailable={!!error} />
      <span className="city-eyebrow">MOVING YOU IN</span>
      <h3>Your own city wallet</h3>
      <p>
        {profile.username} gets a separate NEAR testnet account. Setup happens here automatically—no wallet
        extension is needed.
      </p>
      <ol>
        {steps.map((label, i) => (
          <li key={label} aria-current={i === current ? "step" : undefined}>
            <span aria-hidden="true">{i < current ? "✓" : i === current ? "◉" : "○"}</span> {label}
            {i === current ? "…" : ""}
          </li>
        ))}
      </ol>
      {status?.accountId ? <p className="phone-receipt">{status.accountId}</p> : null}
      <p>
        Testnet only. The game stores your signing key encrypted. Download your recovery backup from the
        Wallet app after the account is confirmed.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {status?.errorCode || error ? (
        <button
          className="game-button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void api
              .retryManagedWallet(profile.id)
              .then(setStatus)
              .catch(() => setError("Retry could not be scheduled. Your account remains saved."))
              .finally(() => setRetrying(false));
          }}
        >
          Recheck saved setup
        </button>
      ) : null}
      {onExplore ? (
        <button className="game-button" onClick={onExplore}>
          Explore while setup finishes
        </button>
      ) : null}
    </section>
  );
}
