import { ensureRole } from "../src/auth/repository.js";
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
if (config.appEnv !== "local" && config.appEnv !== "test") {
  console.error(`refusing role grant for APP_ENV=${config.appEnv}; only local and test are allowed`);
  process.exit(1);
}
if (!confirmed) {
  console.error("refusing role grant without --confirm-grant-role");
  process.exit(1);
}
if (role !== "player" && role !== "operator" && role !== "admin") {
  console.error("role must be player, operator, or admin");
  process.exit(2);
}

await ensureRole(sql, account, role);
console.log(`granted ${role} to ${account}`);
await sql.end();
