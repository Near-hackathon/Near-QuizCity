import { reconcileMirror } from "../src/reconciler.js";
import { sql } from "../src/db.js";

const report = await reconcileMirror(sql);
console.log(JSON.stringify(report, null, 2));
await sql.end();
process.exit(report.ok ? 0 : 1);
