import { sql } from "../src/db.js";
import { seedWorld } from "../db/seeds/world.js";

import { nearQuestionBank } from "../src/near-curriculum.js";
const questions = nearQuestionBank.map((q) => ({ ...q, difficulty: "easy" }));

await sql`
  insert into quizzes (
    id, title, reward_pool, entry_fee, status, question_count, pass_score,
    reward_amount, attempt_duration_seconds, funding_model
  ) values (
    'daily-quiz', 'NEAR Knowledge Round', '1000', '0', 'live', 8, 6, '25', 600, 'mint'
  )
  on conflict (id) do update set
    title = excluded.title, status = 'live', question_count = excluded.question_count,
    pass_score = excluded.pass_score, reward_amount = excluded.reward_amount,
    attempt_duration_seconds = excluded.attempt_duration_seconds
`;

await sql`delete from quiz_questions where quiz_id='daily-quiz' and not (id=any(${questions.map((q) => q.id)}))`;
for (const q of questions) {
  await sql`
    insert into quiz_questions (id, quiz_id, category, difficulty, question, options, correct_index, source)
    values (${q.id}, 'daily-quiz', ${q.category}, ${q.difficulty}, ${q.question},
            ${sql.json(q.options)}, ${q.correct}, ${q.source})
    on conflict (id) do update set
      question = excluded.question,
      options = excluded.options,
      source = excluded.source,
      correct_index = excluded.correct_index
  `;
}

await sql`
  insert into jobs (id, employer_wallet, title, description, payment, status, reference)
  values ('job-research-1', 'npc:professor-kofi', 'Research the foundations of NEAR',
          'Read the official NEAR source brief, answer its knowledge check and submit a summary to Professor Reed.', '100', 'open', 'job-research-1')
  on conflict (id) do nothing
`;

await sql`
  insert into npc_state (npc_id, wallet_id, archetype, budget)
  values ('professor-kofi', 'npc:professor-kofi', 'researcher', 1000),
         ('city-council', 'gov:council', 'government', 0)
  on conflict (npc_id) do update set wallet_id = excluded.wallet_id
`;

console.log("seeded quiz, job, and NPC state");
await seedWorld(sql);
console.log("seeded world model");
await sql.end();
