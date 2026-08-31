CREATE TABLE IF NOT EXISTS "mint_resolver_runs" (
  "id" varchar PRIMARY KEY NOT NULL,
  "resolver_key" varchar NOT NULL,
  "resolver_version" varchar NOT NULL,
  "chain_id" integer NOT NULL,
  "contract_address" varchar NOT NULL,
  "status" varchar NOT NULL CHECK ("status" IN ('resolved', 'needs-input', 'unsupported')),
  "request_hash" varchar NOT NULL,
  "result_json" text NOT NULL,
  "result_hash" varchar NOT NULL,
  "block_number" integer,
  "block_hash" varchar,
  "contract_code_hash" varchar,
  "created_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "mint_resolver_runs_result_hash_unique" ON "mint_resolver_runs" ("result_hash");
CREATE INDEX IF NOT EXISTS "mint_resolver_runs_contract_idx" ON "mint_resolver_runs" ("chain_id", "contract_address", "created_at");

