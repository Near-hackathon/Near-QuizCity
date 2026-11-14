import test from "node:test";
import assert from "node:assert/strict";
import {
  quoteMatch,
  matchRoomQuote,
  matchQuestions,
  scoreMatch,
  matchAnswerHash,
} from "../src/quiz-match-policy.js";
import { nearQuestionBank, isNearLearningSource } from "../src/near-curriculum.js";
test("friend match deducts an exact 2% from the stake with no QC gas fee", () => {
  for (const [stake, fee, prize] of [
    ["50", "1", "98"],
    ["100", "2", "196"],
    ["1000", "20", "1960"],
  ])
    assert.deepEqual(quoteMatch(stake), {
      feePolicy: "deducted-2-v2",
      stake,
      venueFee: fee,
      gasSupportFee: "0",
      totalDue: stake,
      prize,
      payoutPerStake: (BigInt(stake) - BigInt(fee)).toString(),
    });
  for (const stake of [
    "0",
    "20",
    "49",
    "51",
    "101",
    "1001",
    "01",
    "1e2",
    "-50",
    "50.0",
    " 50",
    "9007199254740993",
  ])
    assert.throws(() => quoteMatch(stake));
  assert.deepEqual(matchRoomQuote({ stake: "20", venue_fee: "1", gas_fee: "1", fee_policy: "added-5-v1" }), {
    feePolicy: "added-5-v1",
    stake: "20",
    venueFee: "1",
    gasSupportFee: "1",
    totalDue: "22",
    prize: "40",
    payoutPerStake: "20",
  });
  assert.throws(() => matchRoomQuote({ stake: "100", venue_fee: "2", gas_fee: "0", fee_policy: "unknown" }));
});
test("frozen random NEAR questions retain the right answers after option shuffling", () => {
  const questions = matchQuestions(() => 0);
  assert.equal(questions.length, 5);
  assert.equal(new Set(questions.map((q) => q.id)).size, 5);
  for (const q of questions) {
    const original = nearQuestionBank.find((v) => v.id === q.id)!;
    assert.equal(q.options[q.correct], original.options[original.correct]);
    assert.ok(isNearLearningSource(q.source));
  }
  const correct = Object.fromEntries(questions.map((q) => [q.id, q.correct]));
  assert.equal(scoreMatch(questions, correct), 5);
  assert.equal(
    scoreMatch(
      questions,
      Object.fromEntries(questions.map((q) => [q.id, (q.correct + 1) % q.options.length])),
    ),
    0,
  );
  for (const answers of [
    {},
    { ...correct, unrelated: 0 },
    { ...correct, [questions[0].id]: -1 },
    { ...correct, [questions[0].id]: 3 },
    { ...correct, [questions[0].id]: 0.5 },
  ])
    assert.throws(() => scoreMatch(questions, answers));
  assert.equal(
    matchAnswerHash(correct),
    matchAnswerHash(Object.fromEntries(Object.entries(correct).reverse())),
  );
});
test("all nineteen NEAR learning prompts use official HTTPS sources, with no duplicate ids or invalid answers", () => {
  assert.equal(nearQuestionBank.length, 19);
  assert.equal(new Set(nearQuestionBank.map((q) => q.id)).size, 19);
  for (const q of nearQuestionBank) {
    assert.ok(isNearLearningSource(q.source));
    assert.ok(q.explanation.length > 10);
    assert.ok(q.correct >= 0 && q.correct < q.options.length);
    assert.equal(new Set(q.options).size, q.options.length);
  }
  for (const url of [
    "http://near.org",
    "https://near.org.evil.example",
    "https://user:secret@near.org",
    "javascript:alert(1)",
    "bad",
  ])
    assert.equal(isNearLearningSource(url), false);
});
