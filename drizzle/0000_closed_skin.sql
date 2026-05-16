CREATE TABLE "alert_log" (
	"id" varchar PRIMARY KEY NOT NULL,
	"type" varchar NOT NULL,
	"message" text NOT NULL,
	"channel" varchar DEFAULT 'discord' NOT NULL,
	"job_id" text,
	"status" varchar DEFAULT 'sent' NOT NULL,
	"created_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"chain_id" integer NOT NULL,
	"symbol" varchar DEFAULT 'ETH' NOT NULL,
	"rpc_urls" text NOT NULL,
	"explorer_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT now() NOT NULL,
	CONSTRAINT "chains_chain_id_unique" UNIQUE("chain_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"contract_address" varchar NOT NULL,
	"chain_id" integer NOT NULL,
	"mint_method" varchar DEFAULT 'mint' NOT NULL,
	"mint_abi" text NOT NULL,
	"mint_price" text,
	"max_per_wallet" integer,
	"max_supply" integer,
	"active" boolean DEFAULT true NOT NULL,
	"default_gas_limit" text,
	"default_max_fee_per_gas" text,
	"default_max_priority_fee_per_gas" text,
	"default_use_flashbots" boolean DEFAULT false NOT NULL,
	"fcfs_enabled" boolean DEFAULT false NOT NULL,
	"fcfs_mint_open_signature" text,
	"payment_token" text,
	"safety_check" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_safety_list" (
	"address" varchar PRIMARY KEY NOT NULL,
	"list" varchar NOT NULL,
	"note" text,
	"added_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mint_attempts" (
	"id" varchar PRIMARY KEY NOT NULL,
	"job_id" varchar NOT NULL,
	"tx_hash" text,
	"status" varchar NOT NULL,
	"gas_used" text,
	"effective_gas_price" text,
	"block_number" integer,
	"error" text,
	"raw_tx" text,
	"created_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mint_jobs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"wallet_id" varchar NOT NULL,
	"collection_id" varchar NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"gas_limit" text,
	"max_fee_per_gas" text,
	"max_priority_fee_per_gas" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"nonce" integer,
	"use_flashbots" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"error" text,
	"scheduled_at" text,
	"started_at" text,
	"completed_at" text,
	"created_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rpc_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"url" text NOT NULL,
	"status" varchar DEFAULT 'unknown' NOT NULL,
	"latency_ms" integer,
	"last_checked" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"label" varchar NOT NULL,
	"address" varchar NOT NULL,
	"chain_id" integer DEFAULT 1 NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_format" varchar DEFAULT 'private-key' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"spend_limit" text,
	"hd_path" text,
	"created_at" text DEFAULT now() NOT NULL,
	"updated_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mint_attempts" ADD CONSTRAINT "mint_attempts_job_id_mint_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."mint_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_jobs" ADD CONSTRAINT "mint_jobs_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;