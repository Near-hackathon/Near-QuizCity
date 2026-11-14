import { randomInt, createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { nearQuestionBank, type NearQuestion } from "./near-curriculum.js";
export const MATCH_VENUE_WALLET = "gov:quiz-centre";
export const MATCH_GAS_WALLET = "gov:network-fees";
export const MATCH_FEE_POLICY = "deducted-2-v2";
export function quoteMatch(stake: string) {
  if (
    !/^[1-9][0-9]*$/.test(stake) ||
    BigInt(stake) < 50n ||
    BigInt(stake) > 1000n ||
    BigInt(stake) % 50n !== 0n
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose a stake from 50 to 1,000 QC in steps of 50 for an exact 2% fee.",
      400,
    );
  return matchRoomQuote({
    stake,
    venue_fee: (BigInt(stake) / 50n).toString(),
    gas_fee: "0",
    fee_policy: MATCH_FEE_POLICY,
  });
}
/** Room terms are immutable: old funded escrows keep their original quote. */
export function matchRoomQuote(room: {
  stake: string;
  venue_fee: string;
  gas_fee: string;
  fee_policy: string;
}) {
  const legacy = room.fee_policy === "added-5-v1";
  if (!legacy && room.fee_policy !== MATCH_FEE_POLICY)
    throw new AppError("CONFLICT", "This match fee policy is not supported.", 409);
  const stake = BigInt(room.stake),
    fee = BigInt(room.venue_fee),
    gas = BigInt(room.gas_fee);
  const payout = legacy ? stake : stake - fee;
  return {
    feePolicy: room.fee_policy,
    stake: stake.toString(),
    venueFee: fee.toString(),
    gasSupportFee: gas.toString(),
    totalDue: (legacy ? stake + fee + gas : stake).toString(),
    prize: (payout * 2n).toString(),
    payoutPerStake: payout.toString(),
  };
}
function shuffle<T>(values: T[], random: (max: number) => number) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const n = random(i + 1);
    [result[i], result[n]] = [result[n], result[i]];
  }
  return result;
}
export function matchQuestions(random: (max: number) => number = randomInt): NearQuestion[] {
  return shuffle(nearQuestionBank, random)
    .slice(0, 5)
    .map((q) => {
      const choices = shuffle(
        q.options.map((text, index) => ({ text, index })),
        random,
      );
      return {
        ...q,
        options: choices.map((c) => c.text),
        correct: choices.findIndex((c) => c.index === q.correct),
      };
    });
}
export function scoreMatch(questions: NearQuestion[], answers: Record<string, number>) {
  if (
    Object.keys(answers).sort().join("|") !==
      questions
        .map((q) => q.id)
        .sort()
        .join("|") ||
    questions.some(
      (q) => !Number.isInteger(answers[q.id]) || answers[q.id] < 0 || answers[q.id] >= q.options.length,
    )
  )
    throw new AppError("VALIDATION_ERROR", "Answer all five questions using the offered choices.", 400);
  return questions.filter((q) => answers[q.id] === q.correct).length;
}
export const matchAnswerHash = (answers: Record<string, number>) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
