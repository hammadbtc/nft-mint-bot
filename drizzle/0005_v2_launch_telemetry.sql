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
);
CREATE INDEX IF NOT EXISTS "mint_stage_events_job_idx" ON "mint_stage_events" ("job_id", "started_at");
CREATE INDEX IF NOT EXISTS "mint_stage_events_stage_idx" ON "mint_stage_events" ("stage", "started_at");
