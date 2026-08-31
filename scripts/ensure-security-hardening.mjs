import postgres from "postgres";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to synchronize security hardening");
const migration = await readFile(new URL("../drizzle/0012_security_audit_hardening.sql", import.meta.url), "utf8");
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext('mintbot:migration:security-hardening'))`;
    await transaction.unsafe(migration);
  });
  console.log("Security-audit database invariants are ready");
} finally { await sql.end(); }
