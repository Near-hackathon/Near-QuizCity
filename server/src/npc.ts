import { sql } from "./db.js";
import { viewContract } from "./near.js";

const EMPLOYER = "npc:professor-kofi";
const JOB_PAYMENT = 100;

const JOB_TEMPLATES = [
  {
    title: "Research the city archives",
    description: "Read the district records and file a short summary with Professor Kofi.",
  },
  {
    title: "Index the library shelves",
    description: "Sort the knowledge district catalogue and report missing volumes.",
  },
  {
    title: "Draft a quiz for new residents",
    description: "Write five source-checked questions about the city's history.",
  },
  {
    title: "Host a study session",
    description: "Run an evening revision round at the learning hall.",
  },
];

let running = false;

export async function tickNpcs(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const [openJob] = await sql`
      select 1 from jobs
      where employer_wallet = ${EMPLOYER} and status in ('open', 'accepted')
      limit 1
    `;
    if (openJob) {
      await sql`update npc_state set last_tick_at = now() where npc_id = 'professor-kofi'`;
      return;
    }

    const balance = Number(await viewContract<string>("get_balance", { wallet: EMPLOYER }));
    const [reserved] = await sql<{ total: string }[]>`
      select coalesce(sum(payment), 0)::text as total from jobs
      where employer_wallet = ${EMPLOYER} and status = 'open'
    `;
    if (balance - Number(reserved.total) < JOB_PAYMENT) {
      await sql`update npc_state set last_tick_at = now() where npc_id = 'professor-kofi'`;
      return;
    }

    const [row] = await sql<{ state: { jobs_posted?: number } }[]>`
      select state from npc_state where npc_id = 'professor-kofi'
    `;
    const posted = Number(row?.state?.jobs_posted ?? 0);
    const template = JOB_TEMPLATES[(posted + 1) % JOB_TEMPLATES.length];
    const id = `job-npc-${posted + 1}`;

    const inserted = await sql`
      insert into jobs (id, employer_wallet, title, description, payment, status, reference)
      values (${id}, ${EMPLOYER}, ${template.title}, ${template.description}, ${JOB_PAYMENT}, 'open', ${id})
      on conflict (id) do nothing
      returning id
    `;
    if (inserted.length > 0) {
      await sql`
        update npc_state
        set state = ${sql.json({ ...row?.state, jobs_posted: posted + 1 })}, last_tick_at = now()
        where npc_id = 'professor-kofi'
      `;
      console.log(`[npc] ${EMPLOYER} posted ${id} (wallet ${balance} QC)`);
    }
  } finally {
    running = false;
  }
}
