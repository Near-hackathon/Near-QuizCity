/** Shared guards for destructive local-only operator scripts. */
export function assertLocalOnly(appEnv: string, action: string): void {
  if (appEnv !== "local" && appEnv !== "test") {
    throw new Error(`refusing ${action} for APP_ENV=${appEnv}; only local and test are allowed`);
  }
}

export function assertConfirmed(confirmed: boolean, flag: string): void {
  if (!confirmed) {
    throw new Error(`refusing this action without ${flag}`);
  }
}

export type OperatorRole = "player" | "operator" | "admin";

export function parseOperatorRole(value: string | undefined): OperatorRole {
  if (value !== "player" && value !== "operator" && value !== "admin") {
    throw new Error("role must be player, operator, or admin");
  }
  return value;
}
