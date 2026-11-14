import { Spinner } from "./LoadingStatus";
import type { Static } from "@sinclair/typebox";
import type { ManagedWalletStatus } from "@quiz-city/protocol";
import "./ManagedWalletBrief.css";

type Status = Pick<Static<typeof ManagedWalletStatus>, "stage" | "errorCode">;
const stages = {
  not_requested: {
    step: null,
    title: "Getting your wallet ready",
    description: "We’re checking your saved setup. You don’t need to connect another wallet.",
  },
  creating_account: {
    step: 1,
    title: "Creating your testnet account",
    description:
      "We’re creating your own NEAR testnet account and requesting test NEAR to cover network fees.",
  },
  registering: {
    step: 2,
    title: "Welcoming your account to Quiz City",
    description:
      "Your testnet account is created. We’re registering your resident so you can earn and spend QC.",
  },
  claiming: {
    step: 3,
    title: "Confirming your 500 QC",
    description:
      "Your resident is registered. We’re waiting for the network to confirm your one-time starter allowance.",
  },
  ready: {
    step: null,
    title: "Your wallet is ready",
    description: "Your account and starter allowance are confirmed. You can now use QC in the city.",
  },
} as const;

export function ManagedWalletBrief({
  status,
  unavailable = false,
}: {
  status: Status | null;
  unavailable?: boolean;
}) {
  const stage = stages[status?.stage ?? "not_requested"];
  const brief = unavailable
    ? {
        title: "Checking your saved progress",
        description:
          "We’re reconnecting to check this step. Your account setup is saved; there’s no need to sign up again.",
      }
    : status?.errorCode === "CONTRACT_UPGRADE_REQUIRED"
      ? {
          title: "Waiting for a city update",
          description:
            "Your testnet account is saved. City registration is waiting for an update and will continue automatically afterward.",
        }
      : status?.errorCode === "FAUCET_RATE_LIMITED"
        ? {
            title: "Waiting for testnet funding",
            description:
              "The testnet sponsor is busy. Your account details are saved, and we’ll retry this step automatically.",
          }
        : status?.errorCode
          ? {
              title: "Waiting for confirmation",
              description:
                "This step is taking a little longer. We’re checking your saved setup before continuing—no need to start again.",
            }
          : stage;
  return (
    <div
      className="managed-wallet-brief"
      role="status"
      aria-label="Wallet setup progress"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="managed-wallet-brief-step">
        {stage.step
          ? `WALLET SETUP · STEP ${stage.step} OF 3`
          : status?.stage === "ready"
            ? "WALLET SETUP COMPLETE"
            : "WALLET SETUP"}
      </span>
      <p className="managed-wallet-brief-title">
        {status?.stage !== "ready" && <Spinner />}
        {brief.title}
      </p>
      <p>{brief.description}</p>
    </div>
  );
}
