ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "broadcast_paused" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "mint_definition_versions" (
  "id" varchar PRIMARY KEY NOT NULL,
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "version" integer NOT NULL,
  "status" varchar DEFAULT 'draft' NOT NULL,
  "definition_json" text NOT NULL,
  "definition_hash" varchar NOT NULL,
  "engine_version" varchar DEFAULT 'mint-definition-v1' NOT NULL,
  "source" varchar DEFAULT 'admin' NOT NULL,
  "certified_at" text,
  "activated_at" text,
  "created_at" text DEFAULT now() NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mint_definition_collection_version_unique" ON "mint_definition_versions" ("collection_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "mint_definition_collection_hash_unique" ON "mint_definition_versions" ("collection_id", "definition_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "mint_definition_one_active_per_collection" ON "mint_definition_versions" ("collection_id") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "mint_definition_status_idx" ON "mint_definition_versions" ("status");

CREATE TABLE IF NOT EXISTS "mint_certifications" (
  "id" varchar PRIMARY KEY NOT NULL,
  "definition_version_id" varchar NOT NULL REFERENCES "mint_definition_versions"("id"),
  "status" varchar NOT NULL,
  "checks_json" text NOT NULL,
  "certificate_hash" varchar NOT NULL,
  "certified_at" text NOT NULL,
  "created_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mint_certifications_hash_unique" ON "mint_certifications" ("certificate_hash");
CREATE INDEX IF NOT EXISTS "mint_certifications_definition_idx" ON "mint_certifications" ("definition_version_id", "status");

CREATE TABLE IF NOT EXISTS "mint_phase_controls" (
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "phase_id" varchar NOT NULL,
  "paused" boolean DEFAULT false NOT NULL,
  "reason" text,
  "updated_at" text DEFAULT now() NOT NULL,
  CONSTRAINT "mint_phase_controls_collection_id_phase_id_pk" PRIMARY KEY("collection_id", "phase_id")
);

CREATE TABLE IF NOT EXISTS "mint_payload_artifacts" (
  "id" varchar PRIMARY KEY NOT NULL,
  "collection_id" varchar NOT NULL REFERENCES "collections"("id"),
  "definition_hash" varchar NOT NULL,
  "wallet_address_hash" varchar NOT NULL,
  "phase_id" varchar NOT NULL,
  "quantity" integer NOT NULL,
  "encrypted_payload" text NOT NULL,
  "payload_hash" varchar NOT NULL,
  "expires_at" text NOT NULL,
  "created_at" text DEFAULT now() NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mint_payload_lookup_unique" ON "mint_payload_artifacts" ("collection_id", "definition_hash", "wallet_address_hash", "phase_id", "quantity");
CREATE INDEX IF NOT EXISTS "mint_payload_expiry_idx" ON "mint_payload_artifacts" ("expires_at");

ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "definition_version_id" varchar;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "definition_hash" varchar;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "definition_snapshot" text;
DO $$ BEGIN
  ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_definition_version_id_mint_definition_versions_id_fk"
    FOREIGN KEY ("definition_version_id") REFERENCES "mint_definition_versions"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
