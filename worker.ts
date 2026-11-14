// Cloudflare Worker entry point.
//
// Serves the built SPA from web/dist and proxies API traffic to Fly. The browser
// only ever talks to this Worker's origin, so the session cookie stays first-party
// and is not blocked as a third-party cookie.

const DEFAULT_API_ORIGIN = "https://near-quizcity.fly.dev";

export interface Env {
  ASSETS: Fetcher;
  API_ORIGIN?: string;
}

function apiTarget(pathname: string, search: string, apiOrigin: string): URL {
  return new URL(`${pathname}${search}`, apiOrigin);
}

function forwardHeaders(request: Request, host: string): Headers {
  const headers = new Headers(request.headers);
  headers.set("host", host);
  return headers;
}

async function proxyHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const target = apiTarget(url.pathname, url.search, env.API_ORIGIN ?? DEFAULT_API_ORIGIN);
  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders(request, target.host),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return fetch(target.toString(), init);
}

async function proxyWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const target = apiTarget(url.pathname, url.search, env.API_ORIGIN ?? DEFAULT_API_ORIGIN);
  target.protocol = "wss:";

  const upstreamResponse = await fetch(target.toString(), {
    headers: {
      Upgrade: "websocket",
      Cookie: request.headers.get("cookie") ?? "",
      Origin: request.headers.get("origin") ?? "",
    },
  });
  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    return new Response("The API did not accept the WebSocket upgrade.", { status: 502 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  upstream.accept({ allowHalfOpen: true });
  server.accept({ allowHalfOpen: true });

  upstream.addEventListener("message", (event) => {
    try {
      server.send(event.data as string | ArrayBuffer | ArrayBufferView);
    } catch {
      server.close();
    }
  });
  server.addEventListener("message", (event) => {
    try {
      upstream.send(event.data as string | ArrayBuffer | ArrayBufferView);
    } catch {
      upstream.close();
    }
  });

  const close = () => {
    try {
      upstream.close();
    } catch {
      /* already closed */
    }
    try {
      server.close();
    } catch {
      /* already closed */
    }
  };
  upstream.addEventListener("close", close);
  server.addEventListener("close", close);

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/v1/") || url.pathname.startsWith("/health/");
    if (!isApi) return env.ASSETS.fetch(request);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return proxyWebSocket(request, env);
    }
    return proxyHttp(request, env);
  },
} satisfies ExportedHandler<Env>;
