import postgres from "postgres";
import { config } from "./runtime-config.js";

export const sql = postgres(config.databaseUrl, {
  max: 5,
  ssl: config.pgSsl === "require" ? "require" : false,
  onnotice: () => {},
});

export async function pingDb(): Promise<boolean> {
  const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
  return row.ok === 1;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
