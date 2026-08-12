ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "role" varchar DEFAULT 'worker' NOT NULL;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "parent_wallet_id" varchar;
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_parent_wallet_id_wallets_id_fk" FOREIGN KEY ("parent_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "slug" varchar;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "adapter_key" varchar DEFAULT 'evm-contract-v1' NOT NULL;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "domains" text DEFAULT '[]' NOT NULL;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "site_url" text;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "image_url" text;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "adapter_config" text DEFAULT '{}' NOT NULL;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "verified" boolean DEFAULT false NOT NULL;

ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "claimed_at" text;
ALTER TABLE "mint_jobs" ADD COLUMN IF NOT EXISTS "claim_token" varchar;
CREATE UNIQUE INDEX IF NOT EXISTS "mint_jobs_idempotency_key_unique" ON "mint_jobs" ("idempotency_key");

CREATE TABLE IF NOT EXISTS "disperse_operations" (
  "id" varchar PRIMARY KEY NOT NULL, "type" varchar NOT NULL, "main_wallet_id" varchar NOT NULL,
  "chain_id" integer NOT NULL, "status" varchar DEFAULT 'pending' NOT NULL, "amount_per_wallet" text,
  "error" text, "created_at" text DEFAULT now() NOT NULL, "completed_at" text,
  CONSTRAINT "disperse_operations_main_wallet_id_wallets_id_fk" FOREIGN KEY ("main_wallet_id") REFERENCES "public"."wallets"("id")
);
CREATE TABLE IF NOT EXISTS "disperse_transfers" (
  "id" varchar PRIMARY KEY NOT NULL, "operation_id" varchar NOT NULL, "from_wallet_id" varchar NOT NULL,
  "to_wallet_id" varchar NOT NULL, "amount" text NOT NULL, "status" varchar DEFAULT 'pending' NOT NULL,
  "tx_hash" text, "error" text, "created_at" text DEFAULT now() NOT NULL,
  CONSTRAINT "disperse_transfers_operation_id_disperse_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."disperse_operations"("id"),
  CONSTRAINT "disperse_transfers_from_wallet_id_wallets_id_fk" FOREIGN KEY ("from_wallet_id") REFERENCES "public"."wallets"("id"),
  CONSTRAINT "disperse_transfers_to_wallet_id_wallets_id_fk" FOREIGN KEY ("to_wallet_id") REFERENCES "public"."wallets"("id")
);
