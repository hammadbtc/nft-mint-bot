import postgres from "postgres";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to synchronize Phase 4 eligibility");
const migration = await readFile(new URL("../drizzle/0009_phase04_eligibility_plans.sql", import.meta.url), "utf8");
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext('mintbot:migration:phase04'))`;
    await transaction.unsafe(migration);
  });
  console.log("Phase 4 eligibility database foundation is ready");
} finally {
  await sql.end();
}
