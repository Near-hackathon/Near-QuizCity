export type CleanupStep = {
  name: string;
  run: () => Promise<unknown>;
};

async function bounded(name: string, run: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`cleanup step timed out: ${name}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Attempts every cleanup step and reports all failures only after the last step. */
export async function runCleanupSteps(steps: CleanupStep[], timeoutMs = 15_000): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await bounded(step.name, step.run, timeoutMs);
    } catch (error) {
      failures.push(new Error(`${step.name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "E2E cleanup failed");
}
