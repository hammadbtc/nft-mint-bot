import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to synchronize launch telemetry");
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql.begin(async (transaction) => {
    await transaction`
      CREATE TABLE IF NOT EXISTS "mint_stage_events" (
        "id" varchar PRIMARY KEY NOT NULL,
        "job_id" varchar NOT NULL REFERENCES "mint_jobs"("id"),
        "attempt_id" varchar REFERENCES "mint_attempts"("id"),
        "stage" varchar NOT NULL,
        "outcome" varchar NOT NULL,
        "duration_ms" integer NOT NULL,
        "error" text,
        "started_at" text NOT NULL,
        "completed_at" text NOT NULL
      )
    `;
    await transaction`
      CREATE INDEX IF NOT EXISTS "mint_stage_events_job_idx"
      ON "mint_stage_events" ("job_id", "started_at")
    `;
    await transaction`
      CREATE INDEX IF NOT EXISTS "mint_stage_events_stage_idx"
      ON "mint_stage_events" ("stage", "started_at")
    `;
  });
  console.log("Launch telemetry table is ready");
} finally {
  await sql.end();
}
