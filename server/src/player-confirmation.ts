import type { TransactionSql } from "postgres";
import type { AppConfig } from "./config.js";
import type { ValidatedEvent } from "./event-validation.js";
import { AppError } from "./errors.js";
import { requireExpectedEvent } from "./verify.js";
import { consumeTransaction } from "./transaction-context.js";
import { insertLedgerEntries, ledgerEntryFromEvent } from "./ledger.js";
import { ensureRole } from "./auth/repository.js";
import { setMirroredBalance } from "./sync.js";
export async function confirmPlayerFact(
  tx: TransactionSql,
  cfg: Pick<AppConfig, "networkId" | "contractId">,
  input: {
    accountId: string;
    username: string;
    txHash: string;
    events: ValidatedEvent[];
    balance: string;
    starter: boolean;
  },
) {
  const wallet = `player:${input.accountId}`;
  const proof = requireExpectedEvent(
    input.events,
    input.starter
      ? { name: "starter_allowance", entityId: wallet, walletFrom: null, walletTo: wallet, amount: "500" }
      : { name: "player_registered", entityId: wallet },
  );

  await consumeTransaction(tx, {
    txHash: input.txHash,
    commandType: input.starter ? "claim_starter" : "register_player",
    entityType: "player",
    entityId: input.accountId,
    signerId: input.accountId,
    receiptId: proof.receiptId!,
    eventIndex: proof.eventIndex!,
  });
  if (!input.starter) {
    await tx`insert into players(account_id,username) values(${input.accountId},${input.username}) on conflict(account_id) do update set username=excluded.username`;
    await ensureRole(tx, input.accountId, "player");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.balance))
    throw new AppError("CONFLICT", "The confirmed wallet balance is invalid.", 409);
  await setMirroredBalance(tx, wallet, input.balance);
  await insertLedgerEntries(
    tx,
    input.events
      .map((event) => ledgerEntryFromEvent(event, cfg))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  );
}
