// Cloudflare Pages Functions counterpart to worker.ts. Pages does not execute
// the repository's Worker entry point, so these routes keep API cookies on the
// Pages origin when the static site is deployed there.
const DEFAULT_API_ORIGIN = "https://near-quizcity.fly.dev";

function targetFor(request, apiOrigin) {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, apiOrigin);
  return target;
}

export async function proxyApiRequest(request, env) {
  const target = targetFor(request, env.API_ORIGIN || DEFAULT_API_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("host", target.host);
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return fetch(target, init);
}
