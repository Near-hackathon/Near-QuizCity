import type { TransactionSql } from "postgres";
import { AppError } from "./errors.js";

/** Called only after the common verifier binds the canonical event to the saved intent. */
export async function projectQuizMatchOperation(
  tx: TransactionSql,
  operation: Record<string, any>,
  now = new Date(),
) {
  const p = operation.payload;
  const [room] = await tx`select * from quiz_matches where id=${p.matchRoomId} for update`;
  if (!room) throw new AppError("CONFLICT", "The saved match no longer exists.", 409);
  if (operation.kind === "quiz_fund") {
    const [player] =
      await tx`select * from quiz_match_players where id=${p.matchPlayerId} and match_id=${room.id} and operation_id=${operation.id} for update`;
    if (!player)
      throw new AppError("CONFLICT", "The payment does not belong to this match participant.", 409);
    await tx`update quiz_match_players set funded_at=coalesce(funded_at,${now}) where id=${player.id}`;
    if (room.outcome) {
      await tx`update quiz_matches set state='settling' where id=${room.id}`;
      return;
    }
    if (room.state === "waiting") {
      if (room.join_expires_at <= now) {
        await tx`update quiz_matches set state='settling',outcome='cancelled' where id=${room.id}`;
        return;
      }
      const [count] =
        await tx`select count(*)::int as n from quiz_match_players where match_id=${room.id} and funded_at is not null`;
      if (count.n === 2) {
        const start = new Date(now.getTime() + 5000);
        await tx`update quiz_matches set state='countdown',starts_at=${start},ends_at=${new Date(start.getTime() + 120000)} where id=${room.id}`;
      }
    }
  } else if (operation.kind === "settlement") {
    const [transfer] =
      await tx`update quiz_match_transfers set state='confirmed',lease_token=null,lease_until=null,last_error_code=null where id=${p.matchTransferId} and match_id=${room.id} and operation_id=${operation.id} returning id`;
    if (!transfer) throw new AppError("CONFLICT", "The settlement does not belong to this match.", 409);
  } else throw new AppError("CONFLICT", "Unsupported match operation.", 409);
}
