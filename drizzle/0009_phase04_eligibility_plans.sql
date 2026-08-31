CREATE TABLE IF NOT EXISTS "mint_eligibility_artifacts" (
  "id" varchar PRIMARY KEY NOT NULL,
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "definition_version_id" varchar NOT NULL REFERENCES "mint_definition_versions"("id"),
  "definition_hash" varchar NOT NULL,
  "phase_id" varchar NOT NULL,
  "wallet_address_hash" varchar NOT NULL,
  "strategy" varchar NOT NULL,
  "encrypted_payload" text NOT NULL,
  "artifact_hash" varchar NOT NULL,
  "source_hash" varchar NOT NULL,
  "expires_at" text,
  "created_at" text DEFAULT now() NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mint_eligibility_artifact_lookup_unique"
  ON "mint_eligibility_artifacts" ("definition_version_id", "phase_id", "wallet_address_hash");
CREATE INDEX IF NOT EXISTS "mint_eligibility_artifact_wallet_idx"
  ON "mint_eligibility_artifacts" ("collection_id", "phase_id", "wallet_address_hash");

ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "eligibility_artifact_id" varchar;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "eligibility_artifact_hash" varchar;
DO $$ BEGIN
  ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_eligibility_artifact_id_mint_eligibility_artifacts_id_fk"
    FOREIGN KEY ("eligibility_artifact_id") REFERENCES "mint_eligibility_artifacts"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION mint_eligibility_artifact_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.phase_id IS DISTINCT FROM OLD.phase_id
    OR NEW.wallet_address_hash IS DISTINCT FROM OLD.wallet_address_hash THEN
    RAISE EXCEPTION 'eligibility artifact identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_eligibility_artifact_identity_immutable_trigger ON "mint_eligibility_artifacts";
CREATE TRIGGER mint_eligibility_artifact_identity_immutable_trigger
  BEFORE UPDATE ON "mint_eligibility_artifacts"
  FOR EACH ROW EXECUTE FUNCTION mint_eligibility_artifact_identity_immutable();

CREATE OR REPLACE FUNCTION mint_job_eligibility_pin_immutable() RETURNS trigger AS $$
BEGIN
  IF (OLD.eligibility_artifact_id IS NOT NULL OR OLD.eligibility_artifact_hash IS NOT NULL)
    AND (NEW.eligibility_artifact_id IS DISTINCT FROM OLD.eligibility_artifact_id
      OR NEW.eligibility_artifact_hash IS DISTINCT FROM OLD.eligibility_artifact_hash) THEN
    RAISE EXCEPTION 'mint job eligibility pin is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_job_eligibility_pin_immutable_trigger ON "mint_jobs";
CREATE TRIGGER mint_job_eligibility_pin_immutable_trigger
  BEFORE UPDATE ON "mint_jobs"
  FOR EACH ROW EXECUTE FUNCTION mint_job_eligibility_pin_immutable();

CREATE OR REPLACE FUNCTION mint_job_eligibility_pin_valid() RETURNS trigger AS $$
BEGIN
  IF NEW.eligibility_artifact_id IS NULL AND NEW.eligibility_artifact_hash IS NOT NULL
    OR NEW.eligibility_artifact_id IS NOT NULL AND NEW.eligibility_artifact_hash IS NULL THEN
    RAISE EXCEPTION 'eligibility artifact id and hash must be pinned together';
  END IF;
  IF NEW.eligibility_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mint_eligibility_artifacts a
    WHERE a.id = NEW.eligibility_artifact_id
      AND a.artifact_hash = NEW.eligibility_artifact_hash
      AND a.collection_id = NEW.collection_id
      AND a.definition_version_id = NEW.definition_version_id
      AND a.definition_hash = NEW.definition_hash
      AND a.phase_id = NEW.phase_id
      AND (a.expires_at IS NULL OR a.expires_at::timestamptz > now())
  ) THEN
    RAISE EXCEPTION 'mint job eligibility artifact pin is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_job_eligibility_pin_valid_trigger ON "mint_jobs";
CREATE TRIGGER mint_job_eligibility_pin_valid_trigger
  BEFORE INSERT OR UPDATE ON "mint_jobs"
  FOR EACH ROW EXECUTE FUNCTION mint_job_eligibility_pin_valid();
