/**
 * The production game and its API are deliberately served from one origin.
 * This keeps the device and session cookies first-party. A direct Fly URL
 * would turn the browser profile cookie into a cross-site cookie and break
 * returning-player sign-in.
 */
export function resolveApiBase(
  configured: string | undefined,
  development: boolean,
  browserOrigin: string,
): string {
  const value = configured?.trim().replace(/\/+$/, "");
  if (value) return value;
  return development ? "http://localhost:8787" : browserOrigin.replace(/\/+$/, "");
}

export function browserApiBase(): string {
  return resolveApiBase(import.meta.env.VITE_API_URL, import.meta.env.DEV, window.location.origin);
}
