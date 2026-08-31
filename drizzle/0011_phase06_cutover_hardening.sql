CREATE TABLE IF NOT EXISTS "mint_cutover_states" (
  "collection_id" varchar PRIMARY KEY NOT NULL REFERENCES "collections"("id"),
  "legacy_adapter_key" varchar NOT NULL,
  "candidate_definition_version_id" varchar NOT NULL REFERENCES "mint_definition_versions"("id"),
  "audit_cycle" integer DEFAULT 1 NOT NULL,
  "status" varchar DEFAULT 'shadow' NOT NULL CHECK ("status" IN ('shadow', 'ready', 'cutover', 'rollback')),
  "required_samples" integer DEFAULT 20 NOT NULL CHECK ("required_samples" > 0),
  "matched_count" integer DEFAULT 0 NOT NULL,
  "mismatched_count" integer DEFAULT 0 NOT NULL,
  "error_count" integer DEFAULT 0 NOT NULL,
  "last_comparison_at" text,
  "reason" text,
  "created_at" text DEFAULT now() NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL
);
ALTER TABLE "mint_cutover_states" ADD COLUMN IF NOT EXISTS "audit_cycle" integer DEFAULT 1 NOT NULL;
CREATE INDEX IF NOT EXISTS "mint_cutover_candidate_idx" ON "mint_cutover_states" ("candidate_definition_version_id");

CREATE TABLE IF NOT EXISTS "mint_shadow_comparisons" (
  "id" varchar PRIMARY KEY NOT NULL,
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "candidate_definition_version_id" varchar NOT NULL REFERENCES "mint_definition_versions"("id"),
  "audit_cycle" integer DEFAULT 1 NOT NULL,
  "job_id" varchar NOT NULL REFERENCES "mint_jobs"("id"),
  "phase_id" varchar NOT NULL,
  "wallet_address_hash" varchar NOT NULL,
  "quantity" integer NOT NULL,
  "legacy_intent_hash" varchar,
  "candidate_intent_hash" varchar,
  "status" varchar NOT NULL CHECK ("status" IN ('match', 'mismatch', 'error')),
  "diff_json" text DEFAULT '{}' NOT NULL,
  "created_at" text DEFAULT now() NOT NULL
);
ALTER TABLE "mint_shadow_comparisons" ADD COLUMN IF NOT EXISTS "audit_cycle" integer DEFAULT 1 NOT NULL;
DROP INDEX IF EXISTS "mint_shadow_comparison_job_candidate_phase_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "mint_shadow_comparison_job_candidate_phase_cycle_unique"
  ON "mint_shadow_comparisons" ("job_id", "candidate_definition_version_id", "phase_id", "audit_cycle");
CREATE INDEX IF NOT EXISTS "mint_shadow_comparison_collection_idx" ON "mint_shadow_comparisons" ("collection_id", "created_at");

CREATE TABLE IF NOT EXISTS "mint_incident_bundles" (
  "id" varchar PRIMARY KEY NOT NULL,
  "job_id" varchar NOT NULL REFERENCES "mint_jobs"("id"),
  "trigger" varchar NOT NULL,
  "bundle_json" text NOT NULL,
  "bundle_hash" varchar NOT NULL,
  "created_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mint_incident_bundles_hash_unique" ON "mint_incident_bundles" ("bundle_hash");
CREATE INDEX IF NOT EXISTS "mint_incident_bundles_job_idx" ON "mint_incident_bundles" ("job_id", "created_at");

CREATE OR REPLACE FUNCTION mint_cutover_candidate_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'rollback' AND (NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.candidate_definition_version_id IS DISTINCT FROM OLD.candidate_definition_version_id
    OR NEW.legacy_adapter_key IS DISTINCT FROM OLD.legacy_adapter_key
    OR NEW.audit_cycle IS DISTINCT FROM OLD.audit_cycle) THEN
    RAISE EXCEPTION 'cutover identity is immutable; create a new audit cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_cutover_candidate_immutable_trigger ON "mint_cutover_states";
CREATE TRIGGER mint_cutover_candidate_immutable_trigger BEFORE UPDATE ON "mint_cutover_states"
  FOR EACH ROW EXECUTE FUNCTION mint_cutover_candidate_immutable();
