import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import WebSocket from "ws";
const root = fileURLToPath(new URL("../", import.meta.url));
const folder = await mkdtemp(join(tmpdir(), "quizcity-quiz-ui-"));
const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';import '/src/game/game.css';import {api} from '/src/api.ts';import {ResearchAssignment} from '/src/game/ui/ResearchAssignment.tsx';import {QuizMatches} from '/src/game/ui/QuizMatches.tsx';import {Modal} from '/src/game/ui/Modal.tsx';
const host=createRoot(document.getElementById('root'));const question={id:'near',question:'What pays NEAR transaction gas?',options:['NEAR tokens','Quiz City QC','Answer points'],source:'https://docs.near.org/protocol/transactions/gas'};
const room={id:'10000000-0000-4000-8000-000000000001',code:'ABCDEF1234',visibility:'private',state:'playing',outcome:null,winnerAccount:null,feePolicy:'deducted-2-v2',stake:'100',venueFee:'2',gasSupportFee:'0',totalDue:'100',prize:'196',joinExpiresAt:new Date(Date.now()+900000).toISOString(),startsAt:new Date(Date.now()-1000).toISOString(),endsAt:new Date(Date.now()+120000).toISOString(),participants:[{accountId:'alice.testnet',username:'alice',funded:true,submitted:false,score:null},{accountId:'bob.testnet',username:'bob',funded:true,submitted:false,score:null}],operation:{id:'op',kind:'quiz_fund',method:'fund_escrow',args:{},status:'confirmed',tx_hash:'s'.repeat(43),reference:'fund:escrow',actor_account:'alice.testnet'},questions:[question],review:[],transfers:[]};
window.qa={show(mode){api.publicQuizRooms=async()=>({rooms:[]});api.quizMatches=async()=>({matches:mode==='rooms'?[]:[room]});api.quizMatch=async()=>({match:room});api.researchTask=()=>new Promise(r=>window.qa.finishLoading=()=>r({version:'near',title:'NEAR research',reading:'Learn how NEAR accounts and smart contracts work.',source:question.source,questions:[question]}));api.submitResearch=()=>new Promise(()=>{});host.render(<Modal title={mode==='research'?'NEAR research':'Your city phone'} variant='phone' onClose={()=>{}}>{mode==='research'?<ResearchAssignment key={mode} jobId='qa' accountId='alice.testnet' disabled={false} onUpdated={()=>{}}/>:<QuizMatches key={mode} accountId='alice.testnet' online send={async()=> 's'.repeat(43)} onBalanceChanged={()=>{}}/>}</Modal>);}};window.qa.show('research');`;
let browser, socket;
const vite = await createServer({
  root: join(root, "web"),
  configFile: join(root, "web/vite.config.ts"),
  cacheDir: join(folder, "vite-cache"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "quiz-ui-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === "/__quiz_qa__.tsx") return join(root, "web/src/__quiz_qa__.tsx");
      },
      load(id) {
        if (id === join(root, "web/src/__quiz_qa__.tsx")) return fixture;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/quiz-qa.html") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/quiz-qa.html",
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__quiz_qa__.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = spawn(
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${folder}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port;
  for (let n = 0; n < 200 && !port; n++) {
    try {
      port = Number((await readFile(join(folder, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!port) throw Error("Chrome did not start");
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) =>
    r.json(),
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.once("open", r));
  let seq = 0;
  const pending = new Map(),
    errors = [];
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const cb = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) cb?.reject(Error(message.error.message));
      else cb?.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("Timed out: " + expression);
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: origin + "/quiz-qa.html" });
  await until("document.querySelector('.city-loading-status .city-spinner') !== null");
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('.city-spinner')).animationName"),
    "none",
  );
  await evaluate("window.qa.finishLoading()");
  await until("document.querySelectorAll('input[type=radio]').length===3");
  const layout = await evaluate(
    `(()=>{const option=document.querySelector('.question .option'),input=option.querySelector('input'),text=option.querySelector('span'),a=input.getBoundingClientRect(),b=text.getBoundingClientRect();return {display:getComputedStyle(option).display,color:getComputedStyle(option).color,background:getComputedStyle(option).backgroundColor,radioWidth:a.width,aligned:Math.abs((a.top+a.height/2)-(b.top+b.height/2))<3,labelHeight:option.getBoundingClientRect().height};})()`,
  );
  assert.equal(layout.display, "flex");
  assert.equal(layout.aligned, true);
  assert.ok(layout.radioWidth >= 18);
  assert.ok(layout.labelHeight >= 44);
  assert.equal(layout.color, "rgb(35, 62, 72)");
  await evaluate("document.querySelector('input[type=radio]').click()");
  assert.equal(await evaluate("document.querySelector('input[type=radio]').checked"), true);
  await writeFile(
    "/tmp/quizcity-quiz-choices.png",
    Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"),
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await evaluate("window.qa.show('rooms')");
  await until("document.body.textContent.includes('Create a friend room')");
  await writeFile(
    "/tmp/quizcity-friend-rooms.png",
    Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"),
  );
  await evaluate("window.qa.show('game')");
  await until("document.querySelector('.friend-quiz .question') !== null");
  assert.equal(await evaluate("document.querySelectorAll('.friend-quiz input[type=radio]').length"), 3);
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await until("window.innerWidth===390");
  assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), true);
  await writeFile(
    "/tmp/quizcity-friend-match-mobile.png",
    Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      layout,
      screenshots: [
        "/tmp/quizcity-quiz-choices.png",
        "/tmp/quizcity-friend-rooms.png",
        "/tmp/quizcity-friend-match-mobile.png",
      ],
    }),
  );
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    await new Promise((r) => browser.once("exit", r));
  }
  await vite.close();
  await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
