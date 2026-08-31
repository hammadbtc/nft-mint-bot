ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "broadcast_pause_reason" text;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "broadcast_pause_updated_at" text;

ALTER TABLE "mint_payload_artifacts" ADD COLUMN IF NOT EXISTS "definition_hash" varchar;
UPDATE "mint_payload_artifacts" p SET "definition_hash" = v."definition_hash"
FROM "mint_definition_versions" v
WHERE p."collection_id" = v."collection_id"
  AND v."status" = 'active'
  AND p."definition_hash" IS NULL;
DELETE FROM "mint_payload_artifacts" WHERE "definition_hash" IS NULL;
ALTER TABLE "mint_payload_artifacts" ALTER COLUMN "definition_hash" SET NOT NULL;
DROP INDEX IF EXISTS "mint_payload_lookup_unique";
CREATE UNIQUE INDEX "mint_payload_lookup_unique" ON "mint_payload_artifacts" ("collection_id", "definition_hash", "wallet_address_hash", "phase_id", "quantity");

ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "definition_hash" varchar;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "evidence_json" text DEFAULT '{}' NOT NULL;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "evidence_hash" varchar;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "runner_version" varchar DEFAULT 'mint-certifier-v1' NOT NULL;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "source_commit" varchar;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "expires_at" text;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "revoked_at" text;
ALTER TABLE "mint_certifications" ADD COLUMN IF NOT EXISTS "revocation_reason" text;
UPDATE "mint_certifications" c SET
  "definition_hash" = v."definition_hash",
  "evidence_hash" = v."definition_hash",
  "runner_version" = 'legacy-phase01-v1'
FROM "mint_definition_versions" v
WHERE c."definition_version_id" = v."id"
  AND (c."definition_hash" IS NULL OR c."evidence_hash" IS NULL);
ALTER TABLE "mint_certifications" ALTER COLUMN "definition_hash" SET NOT NULL;
ALTER TABLE "mint_certifications" ALTER COLUMN "evidence_hash" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "mint_control_events" (
  "id" varchar PRIMARY KEY NOT NULL,
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "phase_id" varchar,
  "paused" boolean NOT NULL,
  "reason" text,
  "actor_hash" varchar NOT NULL,
  "created_at" text DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "mint_control_events_collection_idx" ON "mint_control_events" ("collection_id", "created_at");

CREATE TABLE IF NOT EXISTS "mint_definition_activations" (
  "id" varchar PRIMARY KEY NOT NULL,
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "from_definition_version_id" varchar REFERENCES "mint_definition_versions"("id"),
  "to_definition_version_id" varchar NOT NULL REFERENCES "mint_definition_versions"("id"),
  "certification_id" varchar NOT NULL REFERENCES "mint_certifications"("id"),
  "definition_hash" varchar NOT NULL,
  "actor_hash" varchar NOT NULL,
  "activated_at" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "mint_definition_activations_collection_idx" ON "mint_definition_activations" ("collection_id", "activated_at");
DROP INDEX IF EXISTS "mint_definition_activation_target_unique";
CREATE INDEX IF NOT EXISTS "mint_definition_activation_target_idx" ON "mint_definition_activations" ("to_definition_version_id");

DO $$ BEGIN
  ALTER TABLE "mint_definition_versions" ADD CONSTRAINT "mint_definition_status_check"
    CHECK ("status" IN ('draft', 'certified', 'active', 'paused', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "mint_certifications" ADD CONSTRAINT "mint_certification_status_check"
    CHECK ("status" IN ('passed', 'failed', 'revoked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION mint_definition_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.definition_json IS DISTINCT FROM OLD.definition_json
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
    OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'mint definition identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_definition_identity_immutable_trigger ON "mint_definition_versions";
CREATE TRIGGER mint_definition_identity_immutable_trigger
  BEFORE UPDATE ON "mint_definition_versions"
  FOR EACH ROW EXECUTE FUNCTION mint_definition_identity_immutable();

CREATE OR REPLACE FUNCTION mint_definition_status_transition_valid() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('certified', 'retired'))
    OR (OLD.status = 'certified' AND NEW.status IN ('active', 'paused', 'retired'))
    OR (OLD.status = 'active' AND NEW.status IN ('paused', 'retired'))
    OR (OLD.status = 'paused' AND NEW.status IN ('certified', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status IN ('certified', 'active'))
  ) THEN
    RAISE EXCEPTION 'invalid mint definition status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_definition_status_transition_valid_trigger ON "mint_definition_versions";
CREATE TRIGGER mint_definition_status_transition_valid_trigger
  BEFORE UPDATE ON "mint_definition_versions"
  FOR EACH ROW EXECUTE FUNCTION mint_definition_status_transition_valid();

CREATE OR REPLACE FUNCTION mint_definition_activation_has_certificate() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'mint definition must be inserted before certification and activation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status <> 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM mint_certifications c
      WHERE c.definition_version_id = NEW.id
        AND c.definition_hash = NEW.definition_hash
        AND c.status = 'passed'
        AND c.runner_version = 'mint-certifier-v1'
        AND c.expires_at::timestamptz > now()
    ) THEN
      RAISE EXCEPTION 'active mint definition requires a fresh machine certification';
    END IF;
    -- The cutover table is introduced after this foundation migration. Once it
    -- exists, rerunning Phase 2 must preserve (not weaken) the release gate.
    IF to_regclass('mint_cutover_states') IS NOT NULL AND EXISTS (
      SELECT 1 FROM mint_definition_versions previous
      WHERE previous.collection_id = NEW.collection_id
        AND previous.id <> NEW.id
        AND previous.activated_at IS NOT NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM mint_cutover_states s
      WHERE s.collection_id = NEW.collection_id
        AND s.candidate_definition_version_id = NEW.id
        AND s.status = 'ready'
        AND s.matched_count >= s.required_samples
        AND s.mismatched_count = 0
        AND s.error_count = 0
    ) THEN
      RAISE EXCEPTION 'replacement mint definition requires a ready exact-parity cutover';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_definition_activation_has_certificate_trigger ON "mint_definition_versions";
CREATE TRIGGER mint_definition_activation_has_certificate_trigger
  BEFORE INSERT OR UPDATE ON "mint_definition_versions"
  FOR EACH ROW EXECUTE FUNCTION mint_definition_activation_has_certificate();

CREATE OR REPLACE FUNCTION mint_certification_evidence_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id
    OR NEW.checks_json IS DISTINCT FROM OLD.checks_json
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.evidence_json IS DISTINCT FROM OLD.evidence_json
    OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
    OR NEW.runner_version IS DISTINCT FROM OLD.runner_version
    OR NEW.source_commit IS DISTINCT FROM OLD.source_commit
    OR NEW.certificate_hash IS DISTINCT FROM OLD.certificate_hash
    OR NEW.certified_at IS DISTINCT FROM OLD.certified_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'mint certification evidence is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'passed' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'invalid mint certification status transition';
  END IF;
  IF (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason)
    AND NOT (OLD.status = 'passed' AND NEW.status = 'revoked' AND NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid mint certification revocation evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_certification_evidence_immutable_trigger ON "mint_certifications";
CREATE TRIGGER mint_certification_evidence_immutable_trigger
  BEFORE UPDATE ON "mint_certifications"
  FOR EACH ROW EXECUTE FUNCTION mint_certification_evidence_immutable();

CREATE OR REPLACE FUNCTION mint_job_definition_pin_immutable() RETURNS trigger AS $$
BEGIN
  IF (OLD.definition_version_id IS NOT NULL OR OLD.definition_hash IS NOT NULL OR OLD.definition_snapshot IS NOT NULL)
    AND (NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id
      OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
      OR NEW.definition_snapshot IS DISTINCT FROM OLD.definition_snapshot) THEN
    RAISE EXCEPTION 'mint job definition pin is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mint_job_definition_pin_immutable_trigger ON "mint_jobs";
CREATE TRIGGER mint_job_definition_pin_immutable_trigger
  BEFORE UPDATE ON "mint_jobs"
  FOR EACH ROW EXECUTE FUNCTION mint_job_definition_pin_immutable();
