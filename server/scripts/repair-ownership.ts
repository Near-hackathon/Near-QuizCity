import { config } from "../src/runtime-config.js";
import { sql } from "../src/db.js";
import { applyOwnershipRepairs, planOwnershipRepairs } from "../src/ownership-repair.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
if (apply && !args.includes("--confirm-local-repair")) {
  throw new Error("refusing repair without --confirm-local-repair");
}
if (apply && config.appEnv !== "local" && config.appEnv !== "test") {
  throw new Error(`refusing repair for APP_ENV=${config.appEnv}; only local and test are allowed`);
}

const repairs = await planOwnershipRepairs(sql);
console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      mismatches: repairs.length,
      repairs,
    },
    null,
    2,
  ),
);
if (apply && repairs.length > 0) {
  console.log(`updated ${await applyOwnershipRepairs(sql, repairs)} row(s)`);
}
await sql.end();
