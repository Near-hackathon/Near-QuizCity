import { randomBytes, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { AppError } from "./errors.js";
import { insertOperation } from "./city-economy.js";
import { NEAR_CURRICULUM_VERSION, type NearQuestion } from "./near-curriculum.js";
import {
  quoteMatch,
  matchRoomQuote,
  matchQuestions,
  scoreMatch,
  matchAnswerHash,
  MATCH_VENUE_WALLET,
  MATCH_GAS_WALLET,
} from "./quiz-match-policy.js";
export type MatchRow = Record<string, any>;
const fail = (message: string, status = 409): never => {
  throw new AppError(
    status === 403
      ? "FORBIDDEN"
      : status === 404
        ? "NOT_FOUND"
        : status === 400
          ? "VALIDATION_ERROR"
          : "CONFLICT",
    message,
    status,
  );
};
export async function assertMatchVenue(tx: Sql | TransactionSql, account: string, now = new Date()) {
  const [player] = await tx`select account_id from players where account_id=${account}`;
  if (!player) fail("Finish your QC wallet registration before joining a match.", 403);
  const [presence] =
    await tx`select session_id from player_presence where player_account=${account} and scene_id='quiz-centre-interior' and heartbeat_at>${new Date(now.getTime() - 90000)} limit 1`;
  if (!presence) fail("Visit the quiz centre to create or join a match.", 403);
}
async function addPlayer(
  tx: TransactionSql,
  room: MatchRow,
  account: string,
  requestId: string,
  seat: number,
  now: Date,
) {
  const id = randomUUID(),
    escrow = randomUUID();
  const amount = matchRoomQuote(room as Parameters<typeof matchRoomQuote>[0]).totalDue;
  const op = await insertOperation(
    tx,
    account,
    "quiz_fund",
    "fund_escrow",
    { id: escrow, source_wallet: `player:${account}`, beneficiary_wallet: null, amount, purpose: "prize" },
    {
      name: "escrow_funded",
      entityId: `escrow:${escrow}`,
      walletFrom: `player:${account}`,
      walletTo: `gov:escrow.${escrow}`,
      amount,
      reference: `fund:${escrow}`,
    },
    { matchRoomId: room.id, matchPlayerId: id, escrowId: escrow },
  );
  await tx`insert into quiz_match_players(id,match_id,request_id,account_id,seat,escrow_id,operation_id,created_at) values(${id},${room.id},${requestId},${account},${seat},${escrow},${op.id},${now})`;
}
async function lockQuizPool(tx: TransactionSql, stake: string) {
  await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-pool:'||${stake},0))`;
}
async function insertQuizRoom(
  tx: TransactionSql,
  account: string,
  input: { requestId: string; stake: string; visibility?: "private" | "public" },
  now: Date,
  questions: NearQuestion[],
) {
  const quote = quoteMatch(input.stake),
    roomId = randomUUID(),
    code = randomBytes(5).toString("hex").toUpperCase();
  const [room] =
    await tx`insert into quiz_matches(id,request_id,host_account,invite_code,visibility,stake,venue_fee,gas_fee,fee_policy,venue_wallet,gas_wallet,curriculum_version,questions,created_at,join_expires_at) values(${roomId},${input.requestId},${account},${code},${input.visibility ?? "private"},${quote.stake},${quote.venueFee},${quote.gasSupportFee},${quote.feePolicy},${MATCH_VENUE_WALLET},${MATCH_GAS_WALLET},${NEAR_CURRICULUM_VERSION},${tx.json(questions)},${now},${new Date(now.getTime() + 15 * 60000)}) returning *`;
  await addPlayer(tx, room, account, input.requestId, 0, now);
  return roomId;
}
export async function listPublicQuizRooms(
  sql: Sql,
  account: string,
  input: { q?: string; stake?: string } = {},
  now = new Date(),
) {
  if (input.stake) quoteMatch(input.stake);
  const rows =
    await sql`select m.id,coalesce(r.username,p.username) as host,m.stake::text,m.venue_fee::text,m.join_expires_at from quiz_matches m join players p on p.account_id=m.host_account left join resident_profiles r on r.account_id=m.host_account where m.visibility='public' and m.state='waiting' and m.outcome is null and m.fee_policy='deducted-2-v2' and m.join_expires_at>${now} and m.host_account<>${account} and (${input.stake ?? null}::numeric is null or m.stake=${input.stake ?? null}::numeric) and strpos(lower(coalesce(r.username,p.username)),lower(${input.q?.trim() ?? ""}))>0 and (select count(*) from quiz_match_players x where x.match_id=m.id)=1 order by m.created_at desc,m.id desc limit 20`;
  return rows.map((row) => ({
    id: row.id,
    host: row.host,
    stake: row.stake,
    venueFee: row.venue_fee,
    prize: ((BigInt(row.stake) - BigInt(row.venue_fee)) * 2n).toString(),
    expiresAt: row.join_expires_at.toISOString(),
  }));
}
/** The per-stake lock spans selection and reservation, so simultaneous searches form one pair. */
export async function findQuizOpponent(
  sql: Sql,
  account: string,
  input: { requestId: string; stake: string },
  now = new Date(),
) {
  const id = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-request:'||${input.requestId},0))`;
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-account:'||${account},0))`;
    const [prior] = await tx`select * from quiz_match_searches where request_id=${input.requestId}`;
    if (prior) {
      if (prior.account_id !== account || String(prior.stake) !== input.stake)
        fail("This request belongs to a different search.");
      return prior.match_id;
    }
    const [used] = await tx`select id from quiz_match_players where request_id=${input.requestId}`;
    if (used) fail("This request belongs to a different match command.");
    const [searchCount] =
      await tx`select count(*)::int as n from quiz_match_searches where account_id=${account} and created_at>${new Date(now.getTime() - 86400000)}`;
    if (searchCount.n >= 100) fail("Too many new searches today. Reopen your saved room instead.");
    quoteMatch(input.stake);
    await lockQuizPool(tx, input.stake);
    await assertMatchVenue(tx, account, now);
    const [active] =
      await tx`select m.* from quiz_matches m join quiz_match_players p on p.match_id=m.id where p.account_id=${account} and m.state in ('waiting','countdown','playing','settling') for update of m`;
    let roomId: string;
    if (active) {
      if (active.visibility !== "public" || String(active.stake) !== input.stake)
        fail("Finish or cancel your current room before searching at another stake.");
      roomId = active.id;
    } else {
      const [count] =
        await tx`select count(*)::int as n from quiz_match_players where account_id=${account} and created_at>${new Date(now.getTime() - 86400000)}`;
      if (count.n >= 20) fail("You can join up to twenty matches per day.");
      const [room] =
        await tx`select m.* from quiz_matches m where m.visibility='public' and m.state='waiting' and m.outcome is null and m.join_expires_at>${now} and m.stake=${input.stake}::numeric and m.fee_policy='deducted-2-v2' and m.host_account<>${account} and (select count(*) from quiz_match_players p where p.match_id=m.id)=1 order by m.created_at,m.id limit 1 for update of m`;
      if (room) {
        await addPlayer(tx, room, account, input.requestId, 1, now);
        roomId = room.id;
      } else
        roomId = await insertQuizRoom(tx, account, { ...input, visibility: "public" }, now, matchQuestions());
    }
    await tx`insert into quiz_match_searches(request_id,account_id,match_id,stake,created_at) values(${input.requestId},${account},${roomId},${input.stake},${now})`;
    return roomId;
  });
  return getQuizMatch(sql, account, id, now);
}

export async function createQuizMatch(
  sql: Sql,
  account: string,
  input: { requestId: string; stake: string; visibility?: "private" | "public" },
  now = new Date(),
  questions: NearQuestion[] = matchQuestions(),
) {
  const id = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-request:'||${input.requestId},0))`;
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-account:'||${account},0))`;
    const [searched] =
      await tx`select request_id from quiz_match_searches where request_id=${input.requestId}`;
    if (searched) fail("This request belongs to an opponent search.");
    const [prior] = await tx`select * from quiz_matches where request_id=${input.requestId}`;
    if (prior) {
      if (
        prior.host_account !== account ||
        String(prior.stake) !== input.stake ||
        prior.visibility !== (input.visibility ?? "private")
      )
        fail("This request already belongs to a different match.");
      return prior.id;
    }
    if (input.visibility === "public") await lockQuizPool(tx, input.stake);
    quoteMatch(input.stake);
    const [usedRequest] = await tx`select id from quiz_match_players where request_id=${input.requestId}`;
    if (usedRequest) fail("This request belongs to a different match command.");
    await assertMatchVenue(tx, account, now);
    const [pending] =
      await tx`select p.id from quiz_match_players p join quiz_matches m on m.id=p.match_id where p.account_id=${account} and m.state in ('waiting','countdown','playing','settling') limit 1`;
    if (pending) fail("Finish or cancel your current match before opening another.");
    const [count] =
      await tx`select count(*)::int as n from quiz_match_players where account_id=${account} and created_at>${new Date(now.getTime() - 86400000)}`;
    if (count.n >= 20) fail("You can join up to twenty quiz matches per day.");
    return insertQuizRoom(tx, account, input, now, questions);
  });
  return getQuizMatch(sql, account, id, now);
}
export async function joinQuizMatch(
  sql: Sql,
  account: string,
  input: { requestId: string; code: string } | { requestId: string; publicId: string },
  now = new Date(),
) {
  const id = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-request:'||${input.requestId},0))`;
    await tx`select pg_advisory_xact_lock(hashtextextended(current_schema()||':quiz-match-account:'||${account},0))`;
    const [searched] =
      await tx`select request_id from quiz_match_searches where request_id=${input.requestId}`;
    if (searched) fail("This request belongs to an opponent search.");
    const code = "code" in input ? input.code.toUpperCase() : null,
      publicId = "publicId" in input ? input.publicId : null;
    const [prior] =
      await tx`select p.*,m.invite_code,m.visibility from quiz_match_players p join quiz_matches m on m.id=p.match_id where p.request_id=${input.requestId}`;
    if (prior) {
      if (
        prior.seat !== 1 ||
        prior.account_id !== account ||
        (code ? prior.invite_code !== code : prior.match_id !== publicId || prior.visibility !== "public")
      )
        fail("This request belongs to a different match.");
      return prior.match_id;
    }
    const [target] =
      await tx`select * from quiz_matches where (${code}::text is not null and invite_code=${code}) or (${publicId}::uuid is not null and id=${publicId}::uuid and visibility='public')`;
    if (!target) fail("This room is unavailable.", 404);
    if (target.visibility === "public") await lockQuizPool(tx, String(target.stake));
    const [room] = await tx`select * from quiz_matches where id=${target.id} for update`;
    const [existing] =
      await tx`select id from quiz_match_players where match_id=${room.id} and account_id=${account}`;
    if (existing) return room.id;
    if (room.state !== "waiting" || room.join_expires_at <= now)
      fail("This lobby is no longer accepting players.");
    await assertMatchVenue(tx, account, now);
    const [pending] =
      await tx`select p.id from quiz_match_players p join quiz_matches m on m.id=p.match_id where p.account_id=${account} and m.state in ('waiting','countdown','playing','settling') limit 1`;
    if (pending) fail("Finish your current match before joining another.");
    const members = await tx`select id from quiz_match_players where match_id=${room.id}`;
    if (members.length !== 1) fail("This two-player room is full.");
    const [count] =
      await tx`select count(*)::int as n from quiz_match_players where account_id=${account} and created_at>${new Date(now.getTime() - 86400000)}`;
    if (count.n >= 20) fail("You can join up to twenty quiz matches per day.");
    await addPlayer(tx, room, account, input.requestId, 1, now);
    return room.id;
  });
  return getQuizMatch(sql, account, id, now);
}
export async function getQuizMatch(sql: Sql, account: string, id: string, now = new Date()) {
  const [room] =
    await sql`select m.* from quiz_matches m join quiz_match_players p on p.match_id=m.id where m.id=${id} and p.account_id=${account}`;
  if (!room) fail("Match not found for this resident.", 404);
  const members =
    await sql`select p.*,coalesce(r.username,x.username,p.account_id) as username from quiz_match_players p join players x on x.account_id=p.account_id left join resident_profiles r on r.account_id=p.account_id where p.match_id=${id} order by p.seat`;
  const me = members.find((p) => p.account_id === account)!;
  const [operation] = await sql`select * from city_operations where id=${me.operation_id}`;
  const transfers =
    await sql`select t.kind,t.amount::text,t.recipient_wallet,t.state,o.tx_hash from quiz_match_transfers t join city_operations o on o.id=t.operation_id where t.match_id=${id} order by t.id`;
  const quote = matchRoomQuote(room as Parameters<typeof matchRoomQuote>[0]);
  const reveal = room.outcome !== null;
  const canPlay = room.state === "playing" && now >= room.starts_at && now < room.ends_at;
  return {
    id: room.id,
    code: room.invite_code,
    visibility: room.visibility,
    state: room.state,
    outcome: room.outcome,
    winnerAccount: room.winner_account,
    feePolicy: quote.feePolicy,
    stake: String(room.stake),
    venueFee: String(room.venue_fee),
    gasSupportFee: String(room.gas_fee),
    totalDue: quote.totalDue,
    prize: quote.prize,
    joinExpiresAt: room.join_expires_at.toISOString(),
    startsAt: room.starts_at?.toISOString() ?? null,
    endsAt: room.ends_at?.toISOString() ?? null,
    participants: members.map((p) => ({
      accountId: p.account_id,
      username: p.username,
      funded: !!p.funded_at,
      submitted: !!p.submitted_at,
      score: reveal ? p.score : null,
    })),
    operation,
    questions:
      reveal || (canPlay && !me.submitted_at)
        ? (room.questions as NearQuestion[]).map(({ id, question, options, source }) => ({
            id,
            question,
            options,
            source,
          }))
        : [],
    review: reveal
      ? (room.questions as NearQuestion[]).map((q) => ({
          questionId: q.id,
          correctIndex: q.correct,
          explanation: q.explanation,
        }))
      : [],
    transfers: transfers.map((t) => ({
      kind: t.kind,
      amount: t.amount,
      recipientWallet: t.recipient_wallet,
      state: t.state,
      txHash: t.tx_hash,
    })),
  };
}
export async function submitQuizMatch(
  sql: Sql,
  account: string,
  id: string,
  answers: Record<string, number>,
  now = new Date(),
) {
  await sql.begin(async (tx) => {
    const [room] = await tx`select * from quiz_matches where id=${id} for update`;
    const [p] =
      await tx`select * from quiz_match_players where match_id=${id} and account_id=${account} for update`;
    if (!room || !p) fail("Match not found for this resident.", 404);
    const hash = matchAnswerHash(answers);
    if (p.submitted_at) {
      if (p.answer_hash !== hash) fail("Your answers are already locked for this session.");
      return;
    }
    if (room.state !== "playing" || now < room.starts_at || now >= room.ends_at || !p.funded_at)
      fail("This match is not accepting answers now.");
    const score = scoreMatch(room.questions, answers);
    await tx`update quiz_match_players set submitted_at=${now},answers=${tx.json(answers)},answer_hash=${hash},score=${score} where id=${p.id}`;
  });
  return getQuizMatch(sql, account, id, now);
}
export async function cancelQuizMatch(sql: Sql, account: string, id: string) {
  await sql.begin(async (tx) => {
    const [room] =
      await tx`select m.* from quiz_matches m join quiz_match_players p on p.match_id=m.id where m.id=${id} and p.account_id=${account} for update of m`;
    if (!room) fail("Match not found for this resident.", 404);
    if (room.outcome === "cancelled") return;
    if (room.state !== "waiting")
      fail("A funded or started match cannot be cancelled; its result will settle automatically.");
    await tx`update quiz_matches set state='settling',outcome='cancelled' where id=${id}`;
  });
  return getQuizMatch(sql, account, id);
}
export async function advanceQuizMatchLocked(
  tx: TransactionSql,
  room: MatchRow,
  operator: string,
  now = new Date(),
) {
  if (room.state === "waiting" && room.join_expires_at <= now) {
    await tx`update quiz_matches set state='settling',outcome='cancelled' where id=${room.id}`;
    room = { ...room, state: "settling", outcome: "cancelled" };
  }
  if (room.state === "countdown" && room.starts_at <= now) {
    await tx`update quiz_matches set state='playing' where id=${room.id}`;
    room = { ...room, state: "playing" };
  }
  const members = await tx`select * from quiz_match_players where match_id=${room.id} order by seat`;
  if (room.state === "playing" && (room.ends_at <= now || members.every((p) => p.submitted_at))) {
    await tx`update quiz_match_players set submitted_at=${now},score=0,answers='{}'::jsonb where match_id=${room.id} and submitted_at is null`;
    const score = members.map((p) => p.score ?? 0),
      winner = score[0] === score[1] ? null : members[score[0] > score[1] ? 0 : 1].account_id;
    await tx`update quiz_matches set state='settling',outcome=${winner ? "win" : "tie"},winner_account=${winner} where id=${room.id}`;
    room = { ...room, state: "settling", outcome: winner ? "win" : "tie", winner_account: winner };
  }
  if (!room.outcome) return;
  const quote = matchRoomQuote(room as Parameters<typeof matchRoomQuote>[0]);
  for (const p of members.filter((p) => p.funded_at)) {
    const targets =
      room.outcome === "win"
        ? [
            ["stake", quote.payoutPerStake, `player:${room.winner_account}`],
            ["venue", room.venue_fee, room.venue_wallet],
            ["gas", room.gas_fee, room.gas_wallet],
          ]
        : [["refund", quote.totalDue, `player:${p.account_id}`]];
    for (const [kind, amount, recipient] of targets) {
      if (BigInt(String(amount)) === 0n) continue;
      const [prior] = await tx`select id from quiz_match_transfers where player_id=${p.id} and kind=${kind}`;
      if (prior) continue;
      const transferId = randomUUID(),
        reference = `settle:${p.escrow_id}:match:${kind}`;
      const op = await insertOperation(
        tx,
        operator,
        "settlement",
        "settle_escrow",
        {
          id: p.escrow_id,
          recipient_wallet: recipient,
          amount: String(amount),
          refund: kind === "refund",
          reference,
        },
        {
          name: kind === "refund" ? "escrow_refunded" : "escrow_released",
          entityId: `escrow:${p.escrow_id}`,
          walletFrom: `gov:escrow.${p.escrow_id}`,
          walletTo: recipient,
          amount: String(amount),
          reference,
        },
        { matchRoomId: room.id, matchTransferId: transferId, signerAccount: operator },
      );
      await tx`insert into quiz_match_transfers(id,match_id,player_id,kind,amount,recipient_wallet,operation_id) values(${transferId},${room.id},${p.id},${kind},${String(amount)},${recipient},${op.id})`;
    }
  }
  const [pending] =
    await tx`select id from quiz_match_transfers where match_id=${room.id} and state<>'confirmed' limit 1`;
  if (!pending)
    await tx`update quiz_matches set state=${room.outcome === "win" ? "completed" : "refunded"} where id=${room.id}`;
}
