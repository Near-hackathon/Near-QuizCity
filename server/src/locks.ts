export type LockScope = {
  networkId: string;
  contractId: string;
};

/** Shared exclusion key for operations that replace the chain-owned mirror. */
export function rebuildLockKey(scope: LockScope): string {
  return `quizcity-rebuild:${scope.networkId}:${scope.contractId}`;
}

/** Serializes full authoritative snapshot syncs for one contract. */
export function syncLockKey(scope: LockScope): string {
  return `quizcity-sync:${scope.networkId}:${scope.contractId}`;
}
