import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Chains ────────────────────────────────────────────────────────────
export const chains = sqliteTable("chains", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  chainId: integer("chain_id").notNull().unique(),
  symbol: text("symbol").notNull().default("ETH"),
  rpcUrls: text("rpc_urls").notNull(), // JSON array, first is primary
  explorerUrl: text("explorer_url"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Wallets ───────────────────────────────────────────────────────────
export const wallets = sqliteTable("wallets", {
  id: text("id").primaryKey(), // uuid
  label: text("label").notNull(),
  address: text("address").notNull(),
  chainId: integer("chain_id").notNull().default(1), // default ETH mainnet
  encryptedKey: text("encrypted_key").notNull(), // AES-256-GCM encrypted JSON
  // salt + iv encoded in the encrypted payload, or stored separately
  keyFormat: text("key_format").notNull().default("private-key"), // private-key | mnemonic | keystore
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Collections ───────────────────────────────────────────────────────
export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(), // uuid
  name: text("name").notNull(),
  contractAddress: text("contract_address").notNull(),
  chainId: integer("chain_id").notNull(),
  mintMethod: text("mint_method").notNull().default("mint"), // function name
  mintAbi: text("mint_abi").notNull(), // JSON: ABI fragment for the mint function
  mintPrice: text("mint_price"), // in wei, as string to avoid overflow
  maxPerWallet: integer("max_per_wallet"),
  maxSupply: integer("max_supply"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Mint Jobs ─────────────────────────────────────────────────────────
export const mintJobs = sqliteTable("mint_jobs", {
  id: text("id").primaryKey(), // uuid
  walletId: text("wallet_id")
    .notNull()
    .references(() => wallets.id),
  collectionId: text("collection_id")
    .notNull()
    .references(() => collections.id),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed | cancelled
  priority: integer("priority").notNull().default(0),
  gasLimit: text("gas_limit"), // override gas limit
  maxFeePerGas: text("max_fee_per_gas"), // EIP-1559 max fee in wei
  maxPriorityFeePerGas: text("max_priority_fee_per_gas"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  quantity: integer("quantity").notNull().default(1),
  nonce: integer("nonce"), // tracked nonce used for this job
  error: text("error"),
  scheduledAt: text("scheduled_at"), // ISO timestamp for delayed mints
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Mint Attempts (Transaction Log) ───────────────────────────────────
export const mintAttempts = sqliteTable("mint_attempts", {
  id: text("id").primaryKey(), // uuid
  jobId: text("job_id")
    .notNull()
    .references(() => mintJobs.id),
  txHash: text("tx_hash"),
  status: text("status").notNull(), // submitted | confirmed | failed | replaced
  gasUsed: text("gas_used"),
  effectiveGasPrice: text("effective_gas_price"),
  blockNumber: integer("block_number"),
  error: text("error"),
  rawTx: text("raw_tx"), // for debugging/replay
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Settings (global key-value) ───────────────────────────────────────
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── RPC Health ────────────────────────────────────────────────────────
export const rpcHealth = sqliteTable("rpc_health", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chainId: integer("chain_id").notNull(),
  url: text("url").notNull(),
  status: text("status").notNull().default("unknown"), // up | down | slow
  latencyMs: integer("latency_ms"),
  lastChecked: text("last_checked")
    .notNull()
    .default(sql`(datetime('now'))`),
});
