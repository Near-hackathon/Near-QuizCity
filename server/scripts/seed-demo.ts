import { sql } from "../src/db.js";

const questions = [
  {
    id: "q-testnet",
    category: "near",
    difficulty: "easy",
    question: "Which NEAR network uses valueless test tokens?",
    options: ["Testnet", "Mainnet", "Betanet", "Localnet"],
    correct: 0,
  },
  {
    id: "q-qc",
    category: "economy",
    difficulty: "easy",
    question: "What does QC stand for in QUIZ CITY?",
    options: ["Quick Coins", "Quiz Credits", "Quantum Cash", "City Quota"],
    correct: 1,
  },
  {
    id: "q-district",
    category: "city",
    difficulty: "easy",
    question: "Which district hosts the university and library?",
    options: ["Industrial", "Entertainment", "Knowledge", "Residential"],
    correct: 2,
  },
  {
    id: "q-sink",
    category: "economy",
    difficulty: "medium",
    question: "Which of these is NOT a source of QC?",
    options: [
      "Starter allowance",
      "Verified job rewards",
      "Withdrawing to a bank",
      "Fixed-funded competitions",
    ],
    correct: 2,
  },
  {
    id: "q-business",
    category: "city",
    difficulty: "medium",
    question: "What must a player do before opening a business?",
    options: ["Own a plot", "Buy an NFT", "Register a token", "Hire five NPCs"],
    correct: 0,
  },
  {
    id: "q-mayor",
    category: "lore",
    difficulty: "hard",
    question: "Who was QUIZ CITY's first mayor?",
    options: ["Professor Kofi", "Ada Mensah", "Nana Boateng", "Councilor Esi"],
    correct: 1,
  },
  {
    id: "q-integrity",
    category: "integrity",
    difficulty: "medium",
    question: "Where must quiz scoring happen?",
    options: ["In the browser", "On the server", "In the wallet", "On the explorer"],
    correct: 1,
  },
  {
    id: "q-nep",
    category: "near",
    difficulty: "hard",
    question: "Which NEP standard covers non-fungible tokens?",
    options: ["NEP-141", "NEP-171", "NEP-245", "NEP-330"],
    correct: 1,
  },
];

await sql`
  insert into quizzes (id, title, reward_pool, entry_fee, status)
  values ('daily-quiz', 'Daily Knowledge Round', 1000, 0, 'live')
  on conflict (id) do update set status = 'live'
`;

for (const q of questions) {
  await sql`
    insert into quiz_questions (id, quiz_id, category, difficulty, question, options, correct_index, source)
    values (${q.id}, 'daily-quiz', ${q.category}, ${q.difficulty}, ${q.question},
            ${sql.json(q.options)}, ${q.correct}, 'curated')
    on conflict (id) do update set
      question = excluded.question,
      options = excluded.options,
      correct_index = excluded.correct_index
  `;
}

await sql`
  insert into jobs (id, employer_wallet, title, description, payment, status, reference)
  values ('job-research-1', 'npc:professor-kofi', 'Research the city archives',
          'Read the district records and file a short summary with Professor Kofi.', 100, 'open', 'job-research-1')
  on conflict (id) do nothing
`;

await sql`
  insert into npc_state (npc_id, wallet_id, archetype, budget)
  values ('professor-kofi', 'npc:professor-kofi', 'researcher', 1000),
         ('city-council', 'gov:council', 'government', 0)
  on conflict (npc_id) do update set wallet_id = excluded.wallet_id
`;

console.log("seeded quiz, job, and NPC state");
await sql.end();
