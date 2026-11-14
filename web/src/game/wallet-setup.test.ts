import { expect, it, vi } from "vitest";
import { createWalletSetup } from "./wallet-setup";

function fixture() {
  return {
    player: vi.fn().mockResolvedValue(null),
    send: vi.fn().mockImplementation(async (method: string) => `${method}-hash`),
    register: vi.fn().mockResolvedValue({}),
    claim: vi.fn().mockResolvedValue({ balance: "500" }),
  };
}
it("registers and claims with real proof callbacks, and skips an already claimed allowance", async () => {
  const deps = fixture();
  const setup = createWalletSetup(deps);
  await setup("alice");
  expect(deps.register).toHaveBeenCalledWith("alice", "register_player-hash");
  expect(deps.claim).toHaveBeenCalledWith("claim_starter-hash");
  deps.player.mockResolvedValue({ username: "alice", starter_claimed: true });
  await setup("alice");
  expect(deps.send).toHaveBeenCalledTimes(2);
});
it("reuses a confirmed registration proof after mirror failure and does not claim early", async () => {
  const deps = fixture();
  deps.register.mockRejectedValueOnce(new Error("API unavailable"));
  const setup = createWalletSetup(deps);
  await expect(setup("alice")).rejects.toThrow("Confirming registration with the game server failed");
  expect(deps.claim).not.toHaveBeenCalled();
  deps.player.mockResolvedValue({ username: "alice", starter_claimed: false });
  await setup("alice");
  expect(deps.send.mock.calls.filter(([method]) => method === "register_player")).toHaveLength(1);
});
it("reuses the claim proof after API failure without claiming twice", async () => {
  const deps = fixture();
  deps.player.mockResolvedValue({ username: "alice", starter_claimed: false });
  deps.claim.mockRejectedValueOnce(new Error("API unavailable"));
  const setup = createWalletSetup(deps);
  await expect(setup("alice")).rejects.toThrow();
  deps.player.mockResolvedValue({ username: "alice", starter_claimed: true });
  await setup("alice");
  expect(deps.send).toHaveBeenCalledTimes(1);
  expect(deps.claim).toHaveBeenCalledTimes(2);
});
it("does not mutate anything when the chain lookup fails", async () => {
  const deps = fixture();
  deps.player.mockRejectedValue(new Error("RPC unavailable"));
  await expect(createWalletSetup(deps)("alice")).rejects.toThrow();
  expect(deps.send).not.toHaveBeenCalled();
});
