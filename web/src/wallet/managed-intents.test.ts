import { it, expect, vi } from "vitest";
import { sendManagedIntent, forgetManagedProof } from "./managed-intents";
it("reuses a saved request across a lost response and mirror retries, then permits a deliberate next action", async () => {
  const account = crypto.randomUUID(),
    send = vi
      .fn()
      .mockRejectedValueOnce(Error("lost response"))
      .mockResolvedValue({ txHash: "proof", state: "confirmed" });
  await expect(
    sendManagedIntent(account, "business_withdraw", { business_id: 1, amount: "10" }, send),
  ).rejects.toThrow("lost response");
  expect(await sendManagedIntent(account, "business_withdraw", { amount: "10", business_id: 1 }, send)).toBe(
    "proof",
  );
  const id = send.mock.calls[0][0].requestId;
  expect(send.mock.calls[1][0].requestId).toBe(id);
  await sendManagedIntent(account, "business_withdraw", { amount: "10", business_id: 1 }, send);
  expect(send.mock.calls[2][0].requestId).toBe(id);
  forgetManagedProof("proof");
  await sendManagedIntent(account, "business_withdraw", { amount: "10", business_id: 1 }, send);
  expect(send.mock.calls[3][0].requestId).not.toBe(id);
});
it("retains rejected proofs for review instead of silently signing a replacement", async () => {
  const account = crypto.randomUUID(),
    send = vi.fn().mockResolvedValue({ txHash: "rejection", state: "rejected" });
  for (let i = 0; i < 2; i++)
    await expect(sendManagedIntent(account, "buy_property", { property_id: 1 }, send)).rejects.toThrow(
      "rejected",
    );
  expect(send.mock.calls[0][0].requestId).toBe(send.mock.calls[1][0].requestId);
});

it("retains the public request in memory when browser storage cannot be written", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("storage full");
  });
  try {
    const account = crypto.randomUUID(),
      send = vi.fn().mockResolvedValue({ txHash: "memory-proof", state: "confirmed" });
    await sendManagedIntent(account, "business_withdraw", { business_id: 1, amount: "10" }, send);
    await sendManagedIntent(account, "business_withdraw", { business_id: 1, amount: "10" }, send);
    expect(send.mock.calls[0][0].requestId).toBe(send.mock.calls[1][0].requestId);
    forgetManagedProof("memory-proof");
  } finally {
    storage.mockRestore();
  }
});
