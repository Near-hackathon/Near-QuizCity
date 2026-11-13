import { ensureRole } from "../src/auth/repository.js";
import { assertConfirmed, assertLocalOnly, parseOperatorRole } from "../src/script-guards.js";
import { config } from "../src/runtime-config.js";
import { sql } from "../src/db.js";

const args = process.argv.slice(2);
const accountIndex = args.indexOf("--account");
const roleIndex = args.indexOf("--role");
const account = accountIndex >= 0 ? args[accountIndex + 1] : undefined;
const role = roleIndex >= 0 ? args[roleIndex + 1] : undefined;
const confirmed = args.includes("--confirm-grant-role");
const known = new Set(["--account", "--role", "--confirm-grant-role"]);
const unknown = args.filter((argument, index) => {
  if (index > 0 && (args[index - 1] === "--account" || args[index - 1] === "--role")) return false;
  return !known.has(argument);
});

if (unknown.length > 0 || !account || !role) {
  console.error(
    "usage: npm run role:grant -- --account <accountId> --role <player|operator|admin> --confirm-grant-role",
  );
  process.exit(2);
}
let parsedRole;
try {
  assertLocalOnly(config.appEnv, "role grant");
  assertConfirmed(confirmed, "--confirm-grant-role");
  parsedRole = parseOperatorRole(role);
} catch (error) {
  console.error(error instanceof Error ? error.message : "invalid role grant");
  process.exit(1);
}

await ensureRole(sql, account, parsedRole);
console.log(`granted ${role} to ${account}`);
await sql.end();
