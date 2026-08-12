ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "batch_id" varchar;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "phase_id" varchar;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "phase_starts_at" text;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "phase_ends_at" text;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "lease_expires_at" text;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "updated_at" text DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "mint_jobs_status_schedule_idx" ON "mint_jobs" ("status", "scheduled_at");
CREATE INDEX IF NOT EXISTS "mint_jobs_wallet_status_idx" ON "mint_jobs" ("wallet_id", "status");
CREATE INDEX IF NOT EXISTS "mint_jobs_batch_idx" ON "mint_jobs" ("batch_id");

ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "kind" varchar DEFAULT 'mint' NOT NULL;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "nonce" integer;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "to_address" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "value" text DEFAULT '0' NOT NULL;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "data_hash" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "gas_limit" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "max_fee_per_gas" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "max_priority_fee_per_gas" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "prepared_at" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "broadcast_at" text;
ALTER TABLE "mint_attempts" ADD COLUMN IF NOT EXISTS "confirmed_at" text;
CREATE INDEX IF NOT EXISTS "mint_attempts_job_idx" ON "mint_attempts" ("job_id");
CREATE INDEX IF NOT EXISTS "mint_attempts_tx_hash_idx" ON "mint_attempts" ("tx_hash");

ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar;
ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "request_hash" text;
ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "preview_json" text;
ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "claimed_at" text;
ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "lease_expires_at" text;
ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "claim_token" varchar;
ALTER TABLE "disperse_operations" ADD COLUMN IF NOT EXISTS "updated_at" text DEFAULT now() NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "disperse_operations_idempotency_key_unique" ON "disperse_operations" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "disperse_operations_status_idx" ON "disperse_operations" ("status", "created_at");

ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "nonce" integer;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "gas_limit" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "max_fee_per_gas" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "max_priority_fee_per_gas" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "gas_used" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "effective_gas_price" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "block_number" integer;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "raw_tx" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "prepared_at" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "broadcast_at" text;
ALTER TABLE "disperse_transfers" ADD COLUMN IF NOT EXISTS "confirmed_at" text;
CREATE INDEX IF NOT EXISTS "disperse_transfers_operation_idx" ON "disperse_transfers" ("operation_id");
CREATE INDEX IF NOT EXISTS "disperse_transfers_tx_hash_idx" ON "disperse_transfers" ("tx_hash");

CREATE UNIQUE INDEX IF NOT EXISTS "wallets_chain_address_unique" ON "wallets" ("chain_id", lower("address"));
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_one_main_per_chain" ON "wallets" ("chain_id") WHERE "role" = 'main';
CREATE INDEX IF NOT EXISTS "wallets_parent_idx" ON "wallets" ("parent_wallet_id");

CREATE TABLE IF NOT EXISTS "wallet_nonce_state" (
  "wallet_id" varchar PRIMARY KEY NOT NULL,
  "chain_id" integer NOT NULL,
  "next_nonce" integer NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_nonce_state_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id")
);
