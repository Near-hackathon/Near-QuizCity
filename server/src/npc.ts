import type { Sql } from "postgres";
import { attachResearchTask } from "./research-tasks.js";
import { compareQc, subtractQc } from "./amount.js";
import { sql } from "./db.js";
import { viewContract } from "./near.js";
import { startWorker, type WorkerHandle } from "./worker.js";
import { appendJobPresentation } from "./world-projection.js";

const EMPLOYER = "npc:professor-kofi";
const JOB_PAYMENT = "100";
const RESERVED_STATUSES = [
  "open",
  "accepted",
  "submitted",
  "verified",
  "payment_pending",
  "payment_unknown",
] as const;

export const JOB_TEMPLATES = [
  {
    title: "Research the foundations of NEAR",
    description:
      "Read Professor Reed's source brief, complete its knowledge check and submit a short research summary from your phone.",
  },
  {
    title: "Prepare a cross-chain briefing",
    description:
      "Review the NEAR and Intents source brief, answer the knowledge check and explain your findings in a short summary.",
  },
  {
    title: "Write a wallet safety note",
    description:
      "Study the source brief, pass the knowledge check and write a short note explaining safe wallet ownership.",
  },
  {
    title: "Help a new resident learn",
    description:
      "Use the research brief and its knowledge check to prepare a short introduction for a new neighbour.",
  },
];

export type NpcDeps = {
  db: Sql;
  readBalance: (wallet: string) => Promise<string>;
  templates: typeof JOB_TEMPLATES;
  now: () => Date;
};

export type NpcTickResult = {
  created: boolean;
  reason?: string;
  jobId?: string;
};

function defaultDeps(): NpcDeps {
  return {
    db: sql,
    readBalance: (wallet) => viewContract<string>("get_balance", { wallet }),
    templates: JOB_TEMPLATES,
    now: () => new Date(),
  };
}

/**
 * One bounded NPC decision. The advisory lock is the correctness mechanism
 * across server instances; the in-process guard is only a cheap optimization.
 */
export async function tickNpcs(overrides: Partial<NpcDeps> = {}): Promise<NpcTickResult> {
  const deps: NpcDeps = { ...defaultDeps(), ...overrides };
  const balance = await deps.readBalance(EMPLOYER);

  return deps.db.begin(async (transaction) => {
    const [lock] = await transaction<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext('quizcity-npc-worker')) as locked
    `;
    if (!lock?.locked) return { created: false, reason: "leader" };

    const [state] = await transaction<
      {
        state: { jobs_posted?: number };
        budget: string;
      }[]
    >`
      select state, budget from npc_state
      where npc_id = 'professor-kofi'
      for update
    `;
    if (!state) return { created: false, reason: "npc state missing" };

    const [reserved] = await transaction<{ total: string }[]>`
      select coalesce(sum(payment), 0)::text as total from jobs
      where employer_wallet = ${EMPLOYER}
        and status = any(${transaction.array([...RESERVED_STATUSES])}::text[])
    `;
    const available = subtractQc(balance, reserved.total);
    const policyCap = state.budget;
    const spendable =
      compareQc(policyCap, "0") > 0 && compareQc(policyCap, available) < 0 ? policyCap : available;
    if (compareQc(spendable, JOB_PAYMENT) < 0) {
      await transaction`
        update npc_state set last_tick_at = now() where npc_id = 'professor-kofi'
      `;
      return { created: false, reason: "insufficient budget" };
    }

    const posted = Number(state.state?.jobs_posted ?? 0);
    if (deps.templates.length === 0) {
      return { created: false, reason: "no job template" };
    }
    const template = deps.templates[posted % deps.templates.length];
    const id = `job-npc-${posted + 1}`;
    const inserted = await transaction<{ id: string }[]>`
      insert into jobs (id, employer_wallet, title, description, payment, status, reference)
      values (${id}, ${EMPLOYER}, ${template.title}, ${template.description},
              ${JOB_PAYMENT}, 'open', ${id})
      on conflict (id) do nothing
      returning id
    `;

    if (inserted.length > 0) {
      await attachResearchTask(transaction, id);
      await appendJobPresentation(transaction, {
        jobId: id,
        status: "open",
        cityTime: deps.now(),
      });
    }
    await transaction`
      update npc_state
      set state = ${transaction.json({ ...state.state, jobs_posted: posted + 1 })},
          last_tick_at = now()
      where npc_id = 'professor-kofi'
    `;
    return {
      created: inserted.length > 0,
      reason: inserted.length > 0 ? undefined : "already posted",
      jobId: id,
    };
  });
}

export function startNpcWorker(options: {
  intervalMs: number;
  deps?: Partial<NpcDeps>;
  onError?: (error: unknown) => void;
}): WorkerHandle {
  return startWorker({
    intervalMs: options.intervalMs,
    run: async () => {
      await tickNpcs(options.deps);
    },
    onError: options.onError,
  });
}
