import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { makeTestConfig, testEnv } from "./fixtures.js";

Object.assign(process.env, testEnv);
const { registerPublicRoutes } = await import("../src/public-routes.js");
const { registerRoutes } = await import("../src/routes.js");
const { AppError, registerErrorHandler } = await import("../src/errors.js");
const { ajvOptions } = await import("../src/fastify-options.js");

const config = makeTestConfig();
const app = Fastify({
  genReqId: () => `req-${randomUUID()}`,
  ajv: { customOptions: ajvOptions },
});
app.addHook("onSend", async (request, reply, payload) => {
  reply.header("x-request-id", request.id);
  return payload;
});
app.decorateRequest("auth", null);
app.addHook("preValidation", async (request) => {
  request.auth = {
    accountId: "alice.testnet",
    roles: ["player"],
    sessionTokenHash: "test-session",
    csrfHash: "test-csrf",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
});
registerErrorHandler(app);
await app.register(swagger, { openapi: { info: { title: "Quiz City API", version: "1.0.0" } } });
await app.register(
  async (v1) => {
    registerPublicRoutes(v1, config);
    registerRoutes(v1);
  },
  { prefix: "/v1" },
);
await app.ready();

test("validation failures use the shared error envelope and request id", async () => {
  const cases: { url: string; payload?: unknown; contentType?: string }[] = [
    { url: "/v1/players/register" },
    { url: "/v1/players/register", payload: {} },
    {
      url: "/v1/players/register",
      payload: { accountId: "Alice", username: "alice", txHash: "x".repeat(44) },
    },
    {
      url: "/v1/players/register",
      payload: { accountId: "alice.testnet", username: "alice", txHash: "not-a-hash" },
    },
    {
      url: "/v1/players/register",
      payload: { accountId: "alice.testnet", username: "a".repeat(40), txHash: "x".repeat(44) },
    },
    {
      url: "/v1/players/claim",
      payload: { accountId: "alice.testnet", txHash: "x".repeat(44), extra: true },
    },
    {
      url: "/v1/quizzes/quiz-1/submit",
      payload: { accountId: "alice.testnet", attemptId: "not-a-uuid", answers: {} },
    },
    {
      url: "/v1/quizzes/quiz-1/submit",
      payload: {
        accountId: "alice.testnet",
        attemptId: "11111111-1111-4111-8111-111111111111",
        answers: [],
      },
    },
    {
      url: "/v1/properties/not-a-number/buy",
      payload: { accountId: "alice.testnet", txHash: "x".repeat(44) },
    },
    {
      url: "/v1/businesses/1/pay",
      payload: { accountId: "alice.testnet", amount: 20, txHash: "x".repeat(44) },
    },
    {
      url: "/v1/businesses/1/pay",
      payload: {
        accountId: "alice.testnet",
        amount: "9".repeat(39),
        txHash: "x".repeat(44),
      },
    },
  ];

  for (const item of cases) {
    const response = await app.inject({
      method: "POST",
      url: item.url,
      ...(item.payload === undefined ? {} : { payload: item.payload }),
      ...(item.contentType ? { headers: { "content-type": item.contentType } } : {}),
    });
    assert.equal(response.statusCode, 400, `${item.url}: ${response.body}`);
    const body = response.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.equal(typeof body.error.message, "string");
    assert.equal(typeof body.error.requestId, "string");
    assert.equal(response.headers["x-request-id"], body.error.requestId);
    assert.ok(!("stack" in body));
    assert.ok(!JSON.stringify(body).includes("SELECT"));
  }
});

test("malformed JSON and wrong content type fail safely", async () => {
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/players/register",
    payload: "{not json",
    headers: { "content-type": "application/json" },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "VALIDATION_ERROR");

  const wrongType = await app.inject({
    method: "POST",
    url: "/v1/players/register",
    payload: "accountId=alice.testnet",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(wrongType.statusCode, 415);
  const body = wrongType.json();
  assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(typeof body.error.requestId, "string");
});

test("successful responses satisfy their schemas", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/config" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "autoTestnetWallets",
    "contractId",
    "demoMode",
    "networkId",
    "protocolVersion",
  ]);
});

test("forced internal errors return a safe envelope and never leak details", async () => {
  const local = Fastify({ genReqId: () => "req-forced" });
  registerErrorHandler(local);
  local.get("/boom", async () => {
    throw new AppError("FORBIDDEN", "not allowed", 403);
  });
  local.get("/crash", async () => {
    throw new Error("database password is hunter2");
  });
  const forbidden = await local.inject({ method: "GET", url: "/boom" });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "FORBIDDEN");
  assert.equal(forbidden.headers["x-request-id"], undefined);

  const crash = await local.inject({ method: "GET", url: "/crash" });
  assert.equal(crash.statusCode, 500);
  const body = crash.json();
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(body.error.message, "Internal server error");
  assert.ok(!JSON.stringify(body).includes("hunter2"));
  await local.close();
});

test("OpenAPI includes registered routes and no secrets", async () => {
  const document = app.swagger();
  for (const path of [
    "/v1/config",
    "/v1/players/{account}",
    "/v1/players/register",
    "/v1/jobs/{id}/complete",
    "/v1/quizzes/{id}/submit",
    "/v1/properties/{id}/buy",
    "/v1/businesses/{id}/pay",
  ]) {
    assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
  }
  const serialized = JSON.stringify(document);
  assert.ok(!serialized.includes("NEAR_OPERATOR_PRIVATE_KEY"));
  assert.ok(!serialized.includes("DATABASE_URL"));
});

after(async () => {
  await app.close();
});

test("OpenAPI covers every registered route and method", async () => {
  const inventory = new Set<string>();
  const tree = app.printRoutes({ commonPrefix: false });
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const match = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+)\s+\(([^)]+)\)/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4;
    const component = match[2];
    const path = depth === 0 ? component : `${stack[depth - 1]}${component}`;
    stack[depth] = path;
    stack.length = depth + 1;
    const normalized = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    for (const method of match[3].split(",").map((value) => value.trim().toLowerCase())) {
      if (method === "head" || method === "options") continue;
      inventory.add(`${method} ${normalized}`);
    }
  }
  const document = app.swagger();
  for (const entry of inventory) {
    const [method, path] = entry.split(" ");
    assert.ok(
      document.paths[path]?.[method as keyof (typeof document.paths)[string]],
      `missing OpenAPI route ${method.toUpperCase()} ${path}`,
    );
  }
});
