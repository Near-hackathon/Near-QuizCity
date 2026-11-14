import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import { ManagedWalletBrief } from "./ManagedWalletBrief";
import { expectAccessible } from "../test/axe";
it.each([
  ["creating_account", "STEP 1 OF 3", "Creating your testnet account", "test NEAR to cover network fees"],
  ["registering", "STEP 2 OF 3", "Welcoming your account to Quiz City", "so you can earn and spend QC"],
  ["claiming", "STEP 3 OF 3", "Confirming your 500 QC", "waiting for the network to confirm"],
  ["ready", "WALLET SETUP COMPLETE", "Your wallet is ready", "account and starter allowance are confirmed"],
] as const)("explains %s in a short, accessible progress brief", async (stage, step, title, description) => {
  const { container } = render(<ManagedWalletBrief status={{ stage, errorCode: null }} />);
  const brief = screen.getByRole("status", { name: "Wallet setup progress" });
  expect(brief).toHaveTextContent(step);
  expect(brief).toHaveTextContent(title);
  expect(brief).toHaveTextContent(description);
  expect(brief).toHaveAttribute("aria-live", "polite");
  await expectAccessible(container);
});
it("keeps preparation and delays distinct from a confirmed account or allowance", () => {
  const view = render(<ManagedWalletBrief status={null} />);
  const brief = screen.getByRole("status", { name: "Wallet setup progress" });
  expect(brief).toHaveTextContent("Getting your wallet ready");
  expect(brief).not.toHaveTextContent("confirmed");
  view.rerender(
    <ManagedWalletBrief status={{ stage: "creating_account", errorCode: "FAUCET_RATE_LIMITED" }} />,
  );
  expect(brief).toHaveTextContent("Waiting for testnet funding");
  expect(brief).toHaveTextContent("retry this step automatically");
  view.rerender(
    <ManagedWalletBrief status={{ stage: "registering", errorCode: "CONTRACT_UPGRADE_REQUIRED" }} />,
  );
  expect(brief).toHaveTextContent("Waiting for a city update");
  expect(brief).toHaveTextContent("continue automatically afterward");
  view.rerender(<ManagedWalletBrief status={{ stage: "claiming", errorCode: "CHAIN_UNAVAILABLE" }} />);
  expect(brief).toHaveTextContent("Waiting for confirmation");
  expect(brief).not.toHaveTextContent("allowance are confirmed");
  view.rerender(<ManagedWalletBrief status={{ stage: "claiming", errorCode: null }} unavailable />);
  expect(brief).toHaveTextContent("Checking your saved progress");
  expect(brief).toHaveTextContent("no need to sign up again");
});
