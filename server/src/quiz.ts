import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

export const QUIZ_PASS_MARK = 6;
export const QUIZ_REWARD = 25;
export const QUIZ_WINDOW_MS = 10 * 60 * 1000;

export type SnapshotQuestion = {
  position: number;
  question_id: string;
  question: string;
  options: unknown;
  correct_index: number;
  category: string | null;
  difficulty: string | null;
  source: string | null;
};

export class QuizError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "QuizError";
    this.statusCode = statusCode;
  }
}

export function scoreSnapshot(
  questions: SnapshotQuestion[],
  answers: Record<string, number>,
): { score: number; total: number } {
  let score = 0;
  for (const question of questions) {
    if (answers[question.question_id] === question.correct_index) score += 1;
  }
  return { score, total: questions.length };
}

export function attemptExpired(expiresAt: unknown, now = new Date()): boolean {
  const expires = expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt));
  if (Number.isNaN(expires.getTime())) return true;
  return now.getTime() > expires.getTime();
}

export type StoredQuestion = {
  id: string;
  options: unknown;
  correct_index: number;
};

export function assertValidSnapshotQuestion(question: StoredQuestion): void {
  if (!Array.isArray(question.options)) {
    throw new QuizError(`question ${question.id} options must be an array`);
  }
  if (question.options.length < 2) {
    throw new QuizError(`question ${question.id} must have at least two options`);
  }
  if (!question.options.every((option) => typeof option === "string")) {
    throw new QuizError(`question ${question.id} options must all be strings`);
  }
  if (
    !Number.isSafeInteger(question.correct_index) ||
    question.correct_index < 0 ||
    question.correct_index >= question.options.length
  ) {
    throw new QuizError(`question ${question.id} correct_index is outside its options`);
  }
}

export async function startQuizAttempt(
  sql: Sql,
  params: {
    quizId: string;
    accountId: string;
    now?: Date;
    passScore?: number;
    rewardAmount?: number;
    windowMs?: number;
  },
): Promise<{ attemptId: string; questions: SnapshotQuestion[] }> {
  const now = params.now ?? new Date();
  const rewardDay = now.toISOString().slice(0, 10);

  return sql.begin(async (transaction) => {
    const [quiz] = await transaction<
      {
        id: string;
        question_count: number;
        pass_score: number;
        reward_amount: string;
        attempt_duration_seconds: number;
      }[]
    >`
      select id, question_count, pass_score, reward_amount, attempt_duration_seconds
      from quizzes where id = ${params.quizId} and status = 'live'
    `;
    if (!quiz) throw new QuizError("quiz is not live", 404);

    const questions = await transaction<
      {
        id: string;
        question: string;
        options: unknown;
        correct_index: number;
        category: string | null;
        difficulty: string | null;
        source: string | null;
      }[]
    >`
      select id, question, options, correct_index, category, difficulty, source
      from quiz_questions where quiz_id = ${params.quizId}
      order by random() limit ${quiz.question_count}
    `;
    if (questions.length === 0) throw new QuizError("quiz has no questions");

    const passScore = params.passScore ?? Number(quiz.pass_score);
    if (passScore > questions.length) {
      throw new QuizError("quiz does not have enough questions for its pass mark");
    }
    const windowMs = params.windowMs ?? Number(quiz.attempt_duration_seconds) * 1000;
    const expiresAt = new Date(now.getTime() + windowMs);
    const rewardAmount = String(params.rewardAmount ?? quiz.reward_amount);

    for (const question of questions) {
      assertValidSnapshotQuestion({
        id: question.id,
        options: question.options,
        correct_index: question.correct_index,
      });
    }

    const attemptId = randomUUID();
    await transaction`
      insert into quiz_attempts (
        id, quiz_id, player_account, total, status, pass_score, reward_amount,
        expires_at, reward_day, started_at, reward_state
      ) values (
        ${attemptId}, ${params.quizId}, ${params.accountId}, ${questions.length},
        ${"started"}, ${passScore}, ${rewardAmount}, ${expiresAt}, ${rewardDay}, ${now},
        ${"none"}
      )
    `;

    const snapshots: SnapshotQuestion[] = [];
    for (const [position, question] of questions.entries()) {
      await transaction`
        insert into quiz_attempt_questions (
          attempt_id, position, question_id, question, options, correct_index,
          category, difficulty, source
        ) values (
          ${attemptId}, ${position}, ${question.id}, ${question.question},
          ${transaction.json(question.options as Parameters<typeof transaction.json>[0])},
          ${question.correct_index}, ${question.category}, ${question.difficulty}, ${question.source}
        )
      `;
      snapshots.push({
        position,
        question_id: question.id,
        question: question.question,
        options: question.options,
        correct_index: question.correct_index,
        category: question.category,
        difficulty: question.difficulty,
        source: question.source,
      });
    }

    return { attemptId, questions: snapshots };
  });
}

export async function snapshotQuestions(
  client: Sql | TransactionSql,
  attemptId: string,
): Promise<SnapshotQuestion[]> {
  return client<SnapshotQuestion[]>`
    select position, question_id, question, options, correct_index, category, difficulty, source
    from quiz_attempt_questions where attempt_id = ${attemptId} order by position
  `;
}

/**
 * Reserves the player's one daily quiz reward. The unique
 * (player_account, reward_day) constraint makes concurrent attempts safe; an
 * attempt that already owns the reservation is allowed to resume.
 */
export async function reserveQuizReward(
  transaction: TransactionSql,
  params: { playerAccount: string; rewardDay: string; attemptId: string },
): Promise<{ reserved: boolean; ownedByAttempt: boolean }> {
  const [inserted] = await transaction`
    insert into quiz_reward_claims (player_account, reward_day, attempt_id)
    values (${params.playerAccount}, ${params.rewardDay}, ${params.attemptId})
    on conflict (player_account, reward_day) do nothing
    returning attempt_id
  `;
  if (inserted) return { reserved: true, ownedByAttempt: true };

  const [existing] = await transaction`
    select attempt_id from quiz_reward_claims
    where player_account = ${params.playerAccount} and reward_day = ${params.rewardDay}
  `;
  return {
    reserved: false,
    ownedByAttempt: existing?.attempt_id === params.attemptId,
  };
}
