import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import WebSocket from "ws";
import { withTestSchema, connectTestPool, testDatabaseUrl } from "../server/test/db-test-utils.ts";
import { loadMigrations, postgresMigrationStore, runMigrations } from "../server/src/migrations.ts";
import { seedWorld } from "../server/db/seeds/world.ts";
import { makeTestConfig, testEnv } from "../server/test/fixtures.ts";
import { buildApp } from "../server/src/app.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
Object.assign(process.env, testEnv);

await withTestSchema(async ({ sql, schema }) => {
  await runMigrations(postgresMigrationStore(sql), loadMigrations(join(root, "server/db/migrations")));
  await seedWorld(sql);
  let apiBase = "",
    browser,
    socket,
    app,
    pool;
  const folder = await mkdtemp(join(tmpdir(), "quizcity-entry-"));
  const vite = await createServer({
    root: join(root, "web"),
    cacheDir: join(folder, "vite-cache"),
    configFile: join(root, "web/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "isolated-entry-api",
        enforce: "pre",
        transform(code, id) {
          if (id.includes("/src/") && code.includes("import.meta.env.VITE_API_URL"))
            return code.replaceAll("import.meta.env.VITE_API_URL", JSON.stringify(apiBase));
        },
      },
    ],
  });
  try {
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    pool = connectTestPool(testDatabaseUrl(), schema, 8);
    app = await buildApp(makeTestConfig({ webOrigin: origin }), {
      database: pool,
      readiness: { database: async () => true, contract: async () => true },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    apiBase = `http://127.0.0.1:${app.server.address().port}`;
    browser = spawn(
      process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--disable-gpu",
        "--enable-unsafe-swiftshader",
        "--remote-debugging-port=0",
        `--user-data-dir=${folder}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let port;
    const deadline = Date.now() + 10000;
    while (!port) {
      try {
        port = Number((await readFile(join(folder, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      } catch {
        if (Date.now() > deadline) throw Error("Chrome did not start");
        await pause(50);
      }
    }
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) =>
      r.json(),
    );
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => socket.once("open", r));
    let seq = 0;
    const pending = new Map(),
      errors = [];
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id) {
        const cb = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) cb?.reject(Error(msg.error.message));
        else cb?.resolve(msg.result);
      }
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails)
        throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const until = async (expression, label) => {
      const deadline = Date.now() + 20000;
      while (!(await evaluate(expression))) {
        if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
        await pause(100);
      }
    };
    const click = (label) =>
      evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)})||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Button missing');b.click();})()`,
      );
    const type = async (label, text) => {
      await evaluate(
        `(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)});l.querySelector('input').focus();})()`,
      );
      await call("Input.insertText", { text });
    };
    await call("Runtime.enable");
    await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: origin });
    await until("document.querySelector('.landing h1')?.textContent.includes('Your story.')", "landing");
    await writeFile(
      "/tmp/quizcity-new-landing.png",
      Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"),
    );
    await click("Let’s play");
    await type("First name", "Taylor");
    await type("Username", "browser_reader");
    await click("Start my story");
    await until("document.querySelector('.guide-avatar')!==null", "first-visit guide");
    await click("Show me around");
    await click("A blockchain for building applications");
    await click("Next");
    await click("Execute actions across different blockchains");
    await click("Next");
    await click("You — keep them private");
    await click("Finish my welcome");
    await until("document.body.textContent.includes('You’re one of us now.')", "saved onboarding");
    await click("Let me explore");
    await until("document.body.textContent.includes('World: online')", "world connected");
    assert.equal(await evaluate("document.querySelector('.city-hud')===null"), true);
    await click("Open city phone");
    await until("document.querySelector('.city-phone-device')!==null", "phone");
    const bounds = await evaluate(
      "(()=>{const r=document.querySelector('.city-phone-device').getBoundingClientRect();return {width:r.width,height:r.height};})()",
    );
    assert.ok(bounds.height > bounds.width);
    for (const tab of ["Jobs", "Quizzes", "Wallet", "Property", "Business", "Settings", "Help", "Credits"]) {
      await click(tab);
      assert.equal(await evaluate("location.pathname"), "/play");
    }
    await click("Wallet");
    await writeFile(
      "/tmp/quizcity-new-phone.png",
      Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"),
    );
    await click("Sign out");
    await until("location.pathname==='/'&&document.querySelector('.landing')!==null", "sign out");
    await click("Play now");
    await until("document.querySelector('.resident-choices')!==null", "remembered profile");
    await click("browser_reader");
    await until("document.body.textContent.includes('World: online')", "one-click re-entry");
    assert.equal(await evaluate("document.querySelector('.guide-avatar')===null"), true);
    await call("Page.reload");
    await until("document.body.textContent.includes('World: online')", "reload");
    assert.deepEqual(errors, []);
    const [profile] = await sql`select username,onboarding_complete from resident_profiles`;
    assert.equal(profile.username, "browser_reader");
    assert.equal(profile.onboarding_complete, true);
    console.log(
      "PASS: landing → two-field signup → NEAR welcome → all phone apps → sign out → one-click return → reload; isolated real Fastify/PostgreSQL and Chrome",
    );
  } finally {
    socket?.close();
    browser?.kill();
    await vite.close();
    await app?.close();
    await pool?.end();
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
