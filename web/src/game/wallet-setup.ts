import type { ChainPlayer } from "../chain";

export class WalletSetupError extends Error {}

/** Retain confirmed proofs if API persistence fails, so Retry never sends that payment again. */
export function createWalletSetup(deps: {
  player(): Promise<ChainPlayer | null>;
  send(method: string, args: Record<string, unknown>): Promise<string>;
  register(username: string, hash: string): Promise<unknown>;
  claim(hash: string): Promise<unknown>;
}) {
  let registrationHash: string | undefined;
  let claimHash: string | undefined;
  return async (username: string) => {
    let stage = "Checking your on-chain registration";
    try {
      const player = await deps.player();
      if (!player || registrationHash) {
        stage = "Sending your registration transaction";
        registrationHash ??= await deps.send("register_player", { username });
        stage = "Confirming registration with the game server";
        await deps.register(username, registrationHash);
        registrationHash = undefined;
      }
      if (!player?.starter_claimed || claimHash) {
        stage = "Sending your starter allowance claim";
        claimHash ??= await deps.send("claim_starter", {});
        stage = "Confirming your allowance with the game server";
        await deps.claim(claimHash);
        claimHash = undefined;
      }
    } catch {
      throw new WalletSetupError(
        `${stage} failed. No balance has been assumed. Retry to recheck; confirmed transaction proofs will be reused.`,
      );
    }
  };
}
