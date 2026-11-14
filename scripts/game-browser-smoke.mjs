import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const captureScene = process.argv.find((arg) => arg.startsWith("--scene="))?.slice(8);
if (captureScene && !/^[a-z-]+$/.test(captureScene)) throw new Error("Invalid capture scene");
const executable = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(executable)) throw new Error("Set CHROME_PATH to a local Chrome/Chromium executable.");
const profile = await mkdtemp(join(tmpdir(), "quizcity-gate7a-"));
let server;
let browser;
let socket;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  server = await createServer({
    configFile: join(root, "web/vite.config.ts"),
    cacheDir: join(root, "node_modules/.vite-game-smoke"),
    root: join(root, "web"),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite address");
  // Warm the fixture graph (and dependency optimizer) before launching Chrome.
  // Otherwise Vite can optimize/reload the page mid-test and produce a transient
  // "context destroyed" failure on the first run.
  await fetch(`http://127.0.0.1:${address.port}/test/browser/gate7a.html`);
  await server.waitForRequestsIdle();
  const runBrowser = async (stack) => {
    browser = spawn(
      executable,
      [
        "--headless",
        "--no-first-run",
        "--no-default-browser-check",
        "--enable-unsafe-swiftshader",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let launchError;
    browser.on("error", (error) => {
      launchError = error;
    });
    let debugPort;
    const deadline = Date.now() + 10_000;
    while (!debugPort) {
      if (launchError) throw launchError;
      if (browser.exitCode !== null) throw new Error("Chrome exited during startup");
      try {
        debugPort = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      } catch {
        /* Chrome has not written it yet. */
      }
      if (Date.now() > deadline) throw new Error("Chrome startup timed out");
      await delay(50);
    }
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then(
      (response) => response.json(),
    );
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    if (stack) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Cookie setup timed out")), 2000);
        const receive = (data) => {
          const message = JSON.parse(String(data));
          if (message.id !== 4) return;
          clearTimeout(timer);
          socket.off("message", receive);
          if (message.result?.success) resolve();
          else reject(new Error("Cookie setup failed"));
        };
        socket.on("message", receive);
        socket.send(
          JSON.stringify({
            id: 4,
            method: "Network.setCookie",
            params: { ...stack.cookie, httpOnly: true, sameSite: "Lax" },
          }),
        );
      });
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser navigation timed out")), 10_000);
      const onMessage = (data) => {
        const message = JSON.parse(String(data));
        if (message.id === 2) {
          socket.send(
            JSON.stringify({
              id: 3,
              method: "Page.navigate",
              params: {
                url: `http://127.0.0.1:${address.port}/test/browser/gate7a.html${stack ? `?apiBase=${encodeURIComponent(stack.apiBase)}` : process.argv.includes("--capture") ? `?capture=1${process.argv.includes("--interior") ? "&interior=1" : ""}${captureScene ? `&scene=${captureScene}` : ""}${process.argv.includes("--overview") ? "&overview=1" : ""}` : ""}`,
              },
            }),
          );
        }
        if (message.method === "Page.loadEventFired") {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve();
        }
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ id: 2, method: "Page.enable" }));
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser smoke timed out")), 45_000);
      let clickPoint;
      const resumePoll = () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              awaitPromise: true,
              returnByValue: true,
              expression:
                "new Promise(resolve => { const poll = () => { const t = document.getElementById('result')?.textContent; if (t === 'CAPTURE' || t?.startsWith('PASS:') || t?.startsWith('FAIL:') || t?.startsWith('CLICK:')) resolve(t); else setTimeout(poll, 50); }; poll(); })",
            },
          }),
        );
      socket.on("message", async (data) => {
        const message = JSON.parse(String(data));
        if (message.id === 8)
          socket.send(
            JSON.stringify({
              id: 9,
              method: "Input.dispatchMouseEvent",
              params: { type: "mouseReleased", ...clickPoint, button: "left", buttons: 0, clickCount: 1 },
            }),
          );
        if (message.id === 9)
          socket.send(
            JSON.stringify({
              id: 10,
              method: "Runtime.evaluate",
              params: { expression: "document.getElementById('result').textContent = 'CLICKED'" },
            }),
          );
        if (message.id === 10) resumePoll();
        if (message.id === 5 && message.result?.data) {
          await writeFile(
            captureScene
              ? `/tmp/quizcity-${captureScene}.png`
              : process.argv.includes("--interior")
                ? "/tmp/quizcity-library.png"
                : "/tmp/quizcity-city.png",
            Buffer.from(message.result.data, "base64"),
          );
          socket.send(
            JSON.stringify({
              id: 6,
              method: "Runtime.evaluate",
              params: { expression: "document.getElementById('result').textContent = 'CONTINUE'" },
            }),
          );
        }
        if (message.id === 7) {
          socket.send(JSON.stringify({ id: 5, method: "Page.captureScreenshot", params: { format: "png" } }));
        }
        if (message.id !== 1) return;
        if (
          typeof message.result?.result?.value === "string" &&
          message.result.result.value.startsWith("CLICK:")
        ) {
          clickPoint = JSON.parse(message.result.result.value.slice(6));
          socket.send(
            JSON.stringify({
              id: 8,
              method: "Input.dispatchMouseEvent",
              params: { type: "mousePressed", ...clickPoint, button: "left", buttons: 1, clickCount: 1 },
            }),
          );
          return;
        }
        if (message.result?.result?.value === "CAPTURE") {
          socket.send(
            JSON.stringify({
              id: 7,
              method: "Emulation.setDeviceMetricsOverride",
              params: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
            }),
          );
          socket.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                awaitPromise: true,
                returnByValue: true,
                expression:
                  "new Promise(resolve => { const poll = () => { const t = document.getElementById('result')?.textContent; if (t?.startsWith('PASS:') || t?.startsWith('FAIL:')) resolve(t); else setTimeout(poll, 50); }; poll(); })",
              },
            }),
          );
          return;
        }
        if (
          message.error?.code === -32000 &&
          /navigated|context was destroyed|Cannot find context/.test(message.error.message)
        ) {
          await delay(100);
          resumePoll();
          return;
        }
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails)
          reject(
            new Error(
              `Browser evaluation failed: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`,
            ),
          );
        else resolve(message.result?.result?.value);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            returnByValue: true,
            expression: `new Promise(resolve => { const poll = () => { const result = document.getElementById('result')?.textContent; if (result === 'CAPTURE' || result?.startsWith('PASS:') || result?.startsWith('FAIL:') || result?.startsWith('CLICK:')) resolve(result); else setTimeout(poll, 50); }; poll(); })`,
          },
        }),
      );
    });
    if (typeof result !== "string" || !result.startsWith("PASS:")) throw new Error(String(result));
    console.log(result);
  };
  if (process.argv.includes("--local-stack")) {
    const { withWorldBrowserStack } = await import("../server/test/e2e/world-browser-stack.ts");
    await withWorldBrowserStack(`http://127.0.0.1:${address.port}`, runBrowser);
  } else await runBrowser(null);
} finally {
  socket?.terminate();
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          browser.kill("SIGKILL");
          resolve();
        }, 2000);
      }),
    ]);
    clearTimeout(timer);
  }
  await server?.close();
  // Chrome helper processes can finish writing the owned profile after the parent exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
