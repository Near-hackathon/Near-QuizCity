import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { KeyPair } from "near-api-js";
import { nep413Digest } from "../../src/auth/message.js";
import { api, startStack } from "./harness.js";
const stack = await startStack({ city: true, managed: true });
after(() => stack.stop());
const { processManagedWallet } = await import("../../src/wallet-provisioning.js");
test(
  "username signup creates separate real sandbox accounts, confirms one starter grant and signs gameplay without a browser key",
  { timeout: 300000 },
  async () => {
    let cookie = "";
    let csrf = "";
    const request = async (path: string, body?: Record<string, unknown>) => {
      const result = await api(stack, path, {
        ...(body ? { body } : {}),
        cookie,
        csrf,
        headers: { origin: stack.cfg.webOrigin },
      });
      assert.equal(result.status, 200, `${path} returned ${result.status}`);
      return result.body as any;
    };
    const device = await fetch(stack.base + "/v1/profiles/device", {
      method: "POST",
      headers: { origin: stack.cfg.webOrigin, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(device.status, 200);
    cookie = device.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    async function signup(username: string) {
      const response = await fetch(stack.base + "/v1/profiles", {
        method: "POST",
        headers: { origin: stack.cfg.webOrigin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ username, firstName: "Taylor" }),
      });
      assert.equal(response.status, 200);
      const data = (await response.json()) as any;
      csrf = data.csrfToken;
      const session = response.headers.getSetCookie().find((c) => c.startsWith("qc_session="));
      if (session)
        cookie = cookie
          .split("; ")
          .filter((c) => !c.startsWith("qc_session="))
          .concat(session.split(";")[0])
          .join("; ");
      for (let i = 0; i < 12; i++) {
        // Produce real blocks instead of assuming broadcast finality or sleeping.
        await stack.worker.rootAccount.batch(stack.worker.rootAccount.accountId).transfer(1n).transact();
        await stack.db`update managed_wallets set next_attempt_at=now() where profile_id=${data.profile.id}`;
        await processManagedWallet(stack.db, stack.cfg, stack.managedChain!, data.profile.id);
        const [saved] = await stack.db`select stage from managed_wallets where profile_id=${data.profile.id}`;
        if (saved.stage === "ready") break;
      }
      const status = (await fetch(stack.base + `/v1/profiles/${data.profile.id}/wallet`, {
        headers: { cookie },
      }).then((r) => r.json())) as any;
      assert.equal(status.stage, "ready", status.errorCode ?? "setup pending");
      const enter = await fetch(stack.base + "/v1/profiles/enter", {
        method: "POST",
        headers: { origin: stack.cfg.webOrigin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ id: data.profile.id }),
      });
      assert.equal(enter.status, 200);
      const entered = (await enter.json()) as any;
      csrf = entered.csrfToken;
      cookie = cookie
        .split("; ")
        .filter((c) => !c.startsWith("qc_session="))
        .concat(
          enter.headers
            .getSetCookie()
            .find((c) => c.startsWith("qc_session="))!
            .split(";")[0],
        )
        .join("; ");
      return entered.profile;
    }
    const alice = await signup("newreader");
    assert.match(alice.accountId, /^qc-[0-9a-f]{32}\.test.near$/);
    assert.equal(alice.walletKind, "embedded");
    const balance = await stack.readContract<string>("get_balance", { wallet: `player:${alice.accountId}` });
    assert.equal(balance, "500");
    const intent = { requestId: randomUUID(), method: "buy_property", args: { property_id: 1 } };
    const sent = await request("/v1/wallet/transactions", intent);
    const replay = await request("/v1/wallet/transactions", intent);
    assert.equal(sent.txHash, replay.txHash);
    await request("/v1/properties/1/buy", { txHash: sent.txHash });
    assert.equal(
      await stack.readContract<string>("get_balance", { wallet: `player:${alice.accountId}` }),
      "200",
    );
    // A downloaded backup proves access through real NEP-413 on a new browser.
    const backup = await request(`/v1/profiles/${alice.id}/wallet/backup`, { confirm: true });
    const key = KeyPair.fromString(backup.private_key);
    const nonceResult = await api(stack, "/v1/auth/nonce", { body: { accountId: alice.accountId } });
    assert.equal(nonceResult.status, 200);
    const nonce = nonceResult.body as any;
    const digest = nep413Digest({
      message: nonce.message,
      nonce: Buffer.from(nonce.nonce, "base64"),
      recipient: nonce.recipient,
      callbackUrl: nonce.callbackUrl,
    });
    const verified = await api(stack, "/v1/auth/verify", {
      body: {
        accountId: alice.accountId,
        publicKey: key.getPublicKey().toString(),
        signature: Buffer.from(key.sign(digest).signature).toString("base64"),
        nonce: nonce.nonce,
      },
    });
    assert.equal(verified.status, 200);
    const recoveryCookie = verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const linked = await api(stack, "/v1/profiles/link-wallet", {
      body: {},
      cookie: recoveryCookie,
      csrf: (verified.body as any).csrfToken,
    });
    assert.equal(linked.status, 200);
    assert.equal((linked.body as any).profile.id, alice.id);
    const recoveredDevice = linked.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const recovered = await api(stack, "/v1/profiles/enter", {
      body: { id: alice.id },
      cookie: recoveredDevice,
      headers: { origin: stack.cfg.webOrigin },
    });
    assert.equal(recovered.status, 200);
    assert.equal((recovered.body as any).profile.accountId, alice.accountId);
    const bob = await signup("newvisitor");
    assert.notEqual(alice.accountId, bob.accountId);
    assert.equal(
      await stack.readContract<string>("get_balance", { wallet: `player:${bob.accountId}` }),
      "500",
    );
    assert.equal(
      (await stack.db`select count(*)::int as n from managed_wallets where stage='ready'`)[0].n,
      2,
    );
    assert.equal(
      (await stack.db`select count(*)::int as n from transactions where event_name='starter_allowance'`)[0].n,
      2,
    );
    assert.equal((await stack.readContract<any>("get_stats")).total_issued, "11000");
  },
);
