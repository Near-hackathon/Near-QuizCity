import assert from "node:assert/strict";
import test from "node:test";
import { proxyApiRequest } from "./_api-proxy.js";

test("Pages API proxy preserves the page path, query and request body", async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (input, init) => {
    upstream = { url: String(input), init };
    return new Response("ok", { status: 200, headers: { "set-cookie": "qc_session=token; HttpOnly" } });
  };
  try {
    const response = await proxyApiRequest(
      new Request("https://quiz-city.pages.dev/v1/profiles/device?fresh=1", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://quiz-city.pages.dev" },
        body: "{}",
      }),
      { API_ORIGIN: "https://near-quizcity.fly.dev" },
    );
    assert.equal(response.status, 200);
    assert.equal(upstream.url, "https://near-quizcity.fly.dev/v1/profiles/device?fresh=1");
    assert.equal(upstream.init.headers.get("host"), "near-quizcity.fly.dev");
    assert.equal(await new Response(upstream.init.body).text(), "{}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
