import { buildApp } from "./app.js";
import { redactedSummary } from "./config.js";
import { config } from "./runtime-config.js";
import { tickNpcs } from "./npc.js";
import { syncEconomy } from "./sync.js";

const app = await buildApp(config);

try {
  app.log.info({ config: redactedSummary(config) }, "configuration loaded");
  await app.listen({ port: config.port, host: config.host });

  const runSync = async () => {
    try {
      await syncEconomy();
    } catch (error) {
      app.log.warn({ err: error }, "chain sync failed");
    }
  };
  await runSync();
  setInterval(runSync, 10_000);

  const runNpcTick = async () => {
    try {
      await tickNpcs();
    } catch (error) {
      app.log.warn({ err: error }, "npc tick failed");
    }
  };
  await runNpcTick();
  setInterval(runNpcTick, config.npcTickMs);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
