import postgres from "postgres";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to synchronize the Phase 0-1 foundation");

const migration = await readFile(new URL("../drizzle/0006_phase01_foundation.sql", import.meta.url), "utf8");
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });

try {
  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext('mintbot:migration:phase01'))`;
    await transaction.unsafe(migration);
  });
  console.log("Phase 0-1 database foundation is ready");
} finally {
  await sql.end();
}
