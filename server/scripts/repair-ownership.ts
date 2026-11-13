import { config } from "../src/runtime-config.js";
import { sql } from "../src/db.js";
import { applyOwnershipRepairs, planOwnershipRepairs } from "../src/ownership-repair.js";
import { assertConfirmed, assertLocalOnly } from "../src/script-guards.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
if (apply) {
  assertConfirmed(args.includes("--confirm-local-repair"), "--confirm-local-repair");
  assertLocalOnly(config.appEnv, "ownership repair");
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
