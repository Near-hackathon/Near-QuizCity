import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { AppError } from "./errors.js";
import { appendJobPresentation } from "./world-projection.js";
export const researchLesson = {
  version: "near-city-v1",
  title: "Research the foundations of NEAR",
  reading:
    "NEAR Protocol is blockchain infrastructure for applications. NEAR Intents supports execution across different blockchains. Wallet keys prove control of assets: keep private keys private, and only approve transactions you understand.",
  source: "https://near.org/",
  questions: [
    {
      id: "infrastructure",
      question: "What kind of infrastructure is NEAR Protocol?",
      options: ["A blockchain", "A search engine", "A spreadsheet"],
      correct: 0,
    },
    {
      id: "intents",
      question: "What does NEAR Intents support?",
      options: ["Decorating a home", "Cross-chain execution", "Offline file storage"],
      correct: 1,
    },
    {
      id: "ownership",
      question: "Which action protects your city wallet?",
      options: ["Posting your private key", "Approving every request", "Keeping your private key private"],
      correct: 2,
    },
  ],
};
export async function attachResearchTask(tx: TransactionSql, jobId: string) {
  await tx`insert into job_research_tasks(job_id,snapshot) values (${jobId},${tx.json(researchLesson)}) on conflict(job_id) do nothing`;
  await tx`update jobs set has_research_task=true where id=${jobId}`;
}
export async function researchTask(sql: Sql, jobId: string, accountId: string) {
  const [row] =
    await sql`select t.snapshot,j.employee_account,j.status from job_research_tasks t join jobs j on j.id=t.job_id where j.id=${jobId}`;
  if (!row)
    throw new AppError("NOT_FOUND", "This job uses employer review rather than a knowledge check.", 404);
  if (row.status !== "open" && row.employee_account !== accountId)
    throw new AppError("FORBIDDEN", "This assignment belongs to another resident.", 403);
  const snapshot = row.snapshot as typeof researchLesson;
  return {
    version: snapshot.version,
    title: snapshot.title,
    reading: snapshot.reading,
    source: snapshot.source,
    questions: snapshot.questions.map(({ id, question, options }) => ({ id, question, options })),
  };
}
export async function submitResearchTask(
  sql: Sql,
  input: { jobId: string; accountId: string; answers: Record<string, number>; summary: string },
) {
  if (input.summary.trim().length < 20 || input.summary.length > 2000)
    throw new AppError("VALIDATION_ERROR", "Write a research summary between 20 and 2,000 characters.", 400);
  return sql.begin(async (tx) => {
    const [job] = await tx`select * from jobs where id=${input.jobId} for update`;
    if (!job || job.employee_account !== input.accountId)
      throw new AppError("FORBIDDEN", "This assignment belongs to another resident.", 403);
    const [task] = await tx`select snapshot from job_research_tasks where job_id=${input.jobId}`;
    if (!task) throw new AppError("NOT_FOUND", "This assignment requires employer review.", 404);
    const snapshot = task.snapshot as typeof researchLesson;
    const keys = Object.keys(input.answers).sort();
    if (
      keys.join() !==
      snapshot.questions
        .map((q) => q.id)
        .sort()
        .join()
    )
      throw new AppError("VALIDATION_ERROR", "Answer each question in this assignment.", 400);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([keys.map((k) => [k, input.answers[k]]), input.summary.trim()]))
      .digest("hex");
    const [prior] =
      await tx`select score,total from job_research_submissions where job_id=${input.jobId} and fingerprint=${fingerprint}`;
    if (prior) return { job, score: prior.score, total: prior.total, replayed: true };
    if (job.status !== "accepted")
      throw new AppError("CONFLICT", "This assignment is no longer awaiting work.", 409);
    const [count] =
      await tx`select count(*)::int as n from job_research_submissions where job_id=${input.jobId}`;
    if (count.n >= 5)
      throw new AppError(
        "CONFLICT",
        "Five checks have been used. Ask your employer to review this assignment.",
        409,
      );
    const score = snapshot.questions.filter((q) => input.answers[q.id] === q.correct).length;
    await tx`insert into job_research_submissions(job_id,fingerprint,summary,answers,score,total) values (${input.jobId},${fingerprint},${input.summary.trim()},${tx.json(input.answers)},${score},${snapshot.questions.length})`;
    if (score === snapshot.questions.length) {
      const [updated] =
        await tx`update jobs set status='verified',deliverable=${input.summary.trim()},submitted_at=now(),verified_at=now(),verification_notes=${`Deterministic ${snapshot.version} knowledge check passed; summary retained.`} where id=${input.jobId} returning *`;
      await appendJobPresentation(tx, { jobId: input.jobId, status: "verified" });
      return { job: updated, score, total: snapshot.questions.length, replayed: false };
    }
    return { job, score, total: snapshot.questions.length, replayed: false };
  });
}
