import { config } from "../src/runtime-config.js";
import { isLoopbackHost } from "../src/config.js";
import { sql, closeDb } from "../src/db.js";
import { seedResidents } from "../db/seeds/residents.js";

try {
  if (
    !["local", "test"].includes(config.appEnv) ||
    !config.demoMode ||
    config.networkId !== "testnet" ||
    !isLoopbackHost(new URL(config.databaseUrl).hostname)
  )
    throw new Error("Resident demo seeding requires local/test demo mode, testnet and a loopback database.");
  await seedResidents(sql);
  console.log(
    "Five starter residents added/updated; existing runtime, wallet data and venue hours preserved.",
  );
} finally {
  await closeDb();
}
