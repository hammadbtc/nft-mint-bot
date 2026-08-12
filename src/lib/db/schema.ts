import { pgTable, text, integer, boolean, serial, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Chains ────────────────────────────────────────────────────────────
export const chains = pgTable("chains", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  chainId: integer("chain_id").notNull().unique(),
  symbol: varchar("symbol").notNull().default("ETH"),
  rpcUrls: text("rpc_urls").notNull(), // JSON array, first is primary
  explorerUrl: text("explorer_url"),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ─── Wallets ───────────────────────────────────────────────────────────
export const wallets = pgTable("wallets", {
  id: varchar("id").primaryKey(), // uuid
  label: varchar("label").notNull(),
  address: varchar("address").notNull(),
  chainId: integer("chain_id").notNull().default(1),
  encryptedKey: text("encrypted_key").notNull(), // AES-256-GCM encrypted JSON
  keyFormat: varchar("key_format").notNull().default("private-key"),
  active: boolean("active").notNull().default(true),
  spendLimit: text("spend_limit"), // max ETH this wallet can spend total (in wei, null = unlimited)
  hdPath: text("hd_path"), // BIP44 derivation path for mnemonic wallets
  role: varchar("role").notNull().default("worker"), // main | worker
  parentWalletId: varchar("parent_wallet_id"), // main wallet for a worker
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

// ─── Collections ───────────────────────────────────────────────────────
export const collections = pgTable("collections", {
  id: varchar("id").primaryKey(), // uuid
  name: varchar("name").notNull(),
  contractAddress: varchar("contract_address").notNull(),
  chainId: integer("chain_id").notNull(),
  mintMethod: varchar("mint_method").notNull().default("mint"),
  mintAbi: text("mint_abi").notNull(), // JSON: ABI fragment for the mint function
  mintPrice: text("mint_price"), // in wei, as string to avoid overflow
  maxPerWallet: integer("max_per_wallet"),
  maxSupply: integer("max_supply"),
  active: boolean("active").notNull().default(true),
  // Collection-level defaults (overridable per job)
  defaultGasLimit: text("default_gas_limit"),
  defaultMaxFeePerGas: text("default_max_fee_per_gas"),
  defaultMaxPriorityFeePerGas: text("default_max_priority_fee_per_gas"),
  defaultUseFlashbots: boolean("default_use_flashbots").notNull().default(false),
  // FCFS mode
  fcfsEnabled: boolean("fcfs_enabled").notNull().default(false),
  fcfsMintOpenSignature: text("fcfs_mint_open_signature"),
  // ERC20 payment
  paymentToken: text("payment_token"),
  // Safety
  safetyCheck: boolean("safety_check").notNull().default(true),
  slug: varchar("slug"),
  adapterKey: varchar("adapter_key").notNull().default("evm-contract-v1"),
  domains: text("domains").notNull().default("[]"), // JSON string[]
  siteUrl: text("site_url"),
  imageUrl: text("image_url"),
  adapterConfig: text("adapter_config").notNull().default("{}"), // reviewed JSON
  verified: boolean("verified").notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ─── Mint Jobs ─────────────────────────────────────────────────────────
export const mintJobs = pgTable("mint_jobs", {
  id: varchar("id").primaryKey(), // uuid
  walletId: varchar("wallet_id")
    .notNull()
    .references(() => wallets.id),
  collectionId: varchar("collection_id")
    .notNull()
    .references(() => collections.id),
  status: varchar("status").notNull().default("pending"), // pending | running | completed | failed | cancelled
  priority: integer("priority").notNull().default(0),
  gasLimit: text("gas_limit"),
  maxFeePerGas: text("max_fee_per_gas"),
  maxPriorityFeePerGas: text("max_priority_fee_per_gas"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  quantity: integer("quantity").notNull().default(1),
  nonce: integer("nonce"),
  useFlashbots: boolean("use_flashbots").notNull().default(false),
  dryRun: boolean("dry_run").notNull().default(false),
  error: text("error"),
  scheduledAt: text("scheduled_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  idempotencyKey: varchar("idempotency_key").unique(),
  claimedAt: text("claimed_at"),
  claimToken: varchar("claim_token"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ─── Mint Attempts (Transaction Log) ───────────────────────────────────
export const mintAttempts = pgTable("mint_attempts", {
  id: varchar("id").primaryKey(), // uuid
  jobId: varchar("job_id")
    .notNull()
    .references(() => mintJobs.id),
  txHash: text("tx_hash"),
  status: varchar("status").notNull(), // submitted | confirmed | failed | replaced
  gasUsed: text("gas_used"),
  effectiveGasPrice: text("effective_gas_price"),
  blockNumber: integer("block_number"),
  error: text("error"),
  rawTx: text("raw_tx"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ─── Settings (global key-value) ───────────────────────────────────────
export const settings = pgTable("settings", {
  key: varchar("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

// ─── RPC Health ────────────────────────────────────────────────────────
export const rpcHealth = pgTable("rpc_health", {
  id: serial("id").primaryKey(),
  chainId: integer("chain_id").notNull(),
  url: text("url").notNull(),
  status: varchar("status").notNull().default("unknown"), // up | down | slow
  latencyMs: integer("latency_ms"),
  lastChecked: text("last_checked")
    .notNull()
    .default(sql`now()`),
});

// ─── Contract Safety List ─────────────────────────────────────────────
export const contractSafetyList = pgTable("contract_safety_list", {
  address: varchar("address").primaryKey().notNull(),
  list: varchar("list").notNull(), // whitelist | blacklist
  note: text("note"),
  addedAt: text("added_at")
    .notNull()
    .default(sql`now()`),
});

// ─── Alert Log ─────────────────────────────────────────────────────────
export const alertLog = pgTable("alert_log", {
  id: varchar("id").primaryKey(), // uuid
  type: varchar("type").notNull(), // job_failed | rpc_down | job_stuck | batch_complete | fcfs_triggered
  message: text("message").notNull(),
  channel: varchar("channel").notNull().default("discord"),
  jobId: text("job_id"),
  status: varchar("status").notNull().default("sent"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ─── App Config (runtime-editable settings) ────────────────────────────
export const appConfig = pgTable("app_config", {
  key: varchar("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

export const disperseOperations = pgTable("disperse_operations", {
  id: varchar("id").primaryKey(),
  type: varchar("type").notNull(), // fund | sweep
  mainWalletId: varchar("main_wallet_id").notNull().references(() => wallets.id),
  chainId: integer("chain_id").notNull(),
  status: varchar("status").notNull().default("pending"),
  amountPerWallet: text("amount_per_wallet"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`now()`),
  completedAt: text("completed_at"),
});

export const disperseTransfers = pgTable("disperse_transfers", {
  id: varchar("id").primaryKey(),
  operationId: varchar("operation_id").notNull().references(() => disperseOperations.id),
  fromWalletId: varchar("from_wallet_id").notNull().references(() => wallets.id),
  toWalletId: varchar("to_wallet_id").notNull().references(() => wallets.id),
  amount: text("amount").notNull(),
  status: varchar("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`now()`),
});
