export const PROTOCOL_VERSION = "1.0.0";
export const PROTOCOL_MAJOR = 1;

/** Accept the same major; newer minor/patch versions are additive. */
export function isProtocolCompatible(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  if (!match) return false;
  return Number(match[1]) === PROTOCOL_MAJOR;
}

export function assertProtocolCompatible(version: unknown): void {
  if (!isProtocolCompatible(version)) {
    throw new Error(
      `Unsupported protocol version ${String(version)}; this client supports ${PROTOCOL_MAJOR}.x`,
    );
  }
}
