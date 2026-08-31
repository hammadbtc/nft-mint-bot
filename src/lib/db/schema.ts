import { pgTable, text, integer, boolean, serial, varchar, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
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
}, (table) => [
  uniqueIndex("wallets_address_unique").on(sql`lower(${table.address})`),
  index("wallets_parent_idx").on(table.parentWalletId),
]);

export const walletNonceState = pgTable("wallet_nonce_state", {
  walletId: varchar("wallet_id").notNull().references(() => wallets.id),
  chainId: integer("chain_id").notNull(),
  nextNonce: integer("next_nonce").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [primaryKey({ columns: [table.walletId, table.chainId] })]);

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
  // Operational kill switch. This is intentionally mutable and is checked at
  // execution time rather than captured in immutable mint definitions.
  broadcastPaused: boolean("broadcast_paused").notNull().default(false),
  broadcastPauseReason: text("broadcast_pause_reason"),
  broadcastPauseUpdatedAt: text("broadcast_pause_updated_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// Immutable, content-addressed execution definitions. Jobs pin one of these so
// later support edits cannot silently change a queued transaction.
export const mintDefinitionVersions = pgTable("mint_definition_versions", {
  id: varchar("id").primaryKey(),
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  version: integer("version").notNull(),
  status: varchar("status").notNull().default("draft"), // draft | certified | active | paused | retired
  definitionJson: text("definition_json").notNull(),
  definitionHash: varchar("definition_hash").notNull(),
  engineVersion: varchar("engine_version").notNull().default("mint-definition-v1"),
  source: varchar("source").notNull().default("admin"), // admin | seed
  certifiedAt: text("certified_at"),
  activatedAt: text("activated_at"),
  createdAt: text("created_at").notNull().default(sql`now()`),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_definition_collection_version_unique").on(table.collectionId, table.version),
  uniqueIndex("mint_definition_collection_hash_unique").on(table.collectionId, table.definitionHash),
  uniqueIndex("mint_definition_one_active_per_collection").on(table.collectionId).where(sql`${table.status} = 'active'`),
  index("mint_definition_status_idx").on(table.status),
]);

export const mintCertifications = pgTable("mint_certifications", {
  id: varchar("id").primaryKey(),
  definitionVersionId: varchar("definition_version_id").notNull().references(() => mintDefinitionVersions.id),
  status: varchar("status").notNull(), // passed | failed | revoked
  checksJson: text("checks_json").notNull(),
  definitionHash: varchar("definition_hash").notNull(),
  evidenceJson: text("evidence_json").notNull().default("{}"),
  evidenceHash: varchar("evidence_hash").notNull(),
  runnerVersion: varchar("runner_version").notNull().default("mint-certifier-v1"),
  sourceCommit: varchar("source_commit"),
  certificateHash: varchar("certificate_hash").notNull(),
  certifiedAt: text("certified_at").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  revocationReason: text("revocation_reason"),
  createdAt: text("created_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_certifications_hash_unique").on(table.certificateHash),
  index("mint_certifications_definition_idx").on(table.definitionVersionId, table.status),
]);

export const mintPhaseControls = pgTable("mint_phase_controls", {
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  phaseId: varchar("phase_id").notNull(),
  paused: boolean("paused").notNull().default(false),
  reason: text("reason"),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [primaryKey({ columns: [table.collectionId, table.phaseId] })]);

export const mintControlEvents = pgTable("mint_control_events", {
  id: varchar("id").primaryKey(),
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  phaseId: varchar("phase_id"),
  paused: boolean("paused").notNull(),
  reason: text("reason"),
  actorHash: varchar("actor_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`now()`),
}, (table) => [index("mint_control_events_collection_idx").on(table.collectionId, table.createdAt)]);

// Wallet-bound provider payloads are encrypted at rest. Only a wallet hash is
// stored, which is sufficient for deterministic lookup without exposing it.
export const mintPayloadArtifacts = pgTable("mint_payload_artifacts", {
  id: varchar("id").primaryKey(),
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  definitionHash: varchar("definition_hash").notNull(),
  walletAddressHash: varchar("wallet_address_hash").notNull(),
  phaseId: varchar("phase_id").notNull(),
  quantity: integer("quantity").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  payloadHash: varchar("payload_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`now()`),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_payload_lookup_unique").on(table.collectionId, table.definitionHash, table.walletAddressHash, table.phaseId, table.quantity),
  index("mint_payload_expiry_idx").on(table.expiresAt),
]);

// Phase 4: encrypted wallet-scoped allowlist/signature material. Artifacts are
// bound to one immutable definition and are independently integrity-hashed.
export const mintEligibilityArtifacts = pgTable("mint_eligibility_artifacts", {
  id: varchar("id").primaryKey(),
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  definitionVersionId: varchar("definition_version_id").notNull().references(() => mintDefinitionVersions.id),
  definitionHash: varchar("definition_hash").notNull(),
  phaseId: varchar("phase_id").notNull(),
  walletAddressHash: varchar("wallet_address_hash").notNull(),
  strategy: varchar("strategy").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  artifactHash: varchar("artifact_hash").notNull(),
  sourceHash: varchar("source_hash").notNull(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`now()`),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_eligibility_artifact_lookup_unique").on(table.definitionVersionId, table.phaseId, table.walletAddressHash),
  index("mint_eligibility_artifact_wallet_idx").on(table.collectionId, table.phaseId, table.walletAddressHash),
]);

export const mintDefinitionActivations = pgTable("mint_definition_activations", {
  id: varchar("id").primaryKey(),
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  fromDefinitionVersionId: varchar("from_definition_version_id").references(() => mintDefinitionVersions.id),
  toDefinitionVersionId: varchar("to_definition_version_id").notNull().references(() => mintDefinitionVersions.id),
  certificationId: varchar("certification_id").notNull().references(() => mintCertifications.id),
  definitionHash: varchar("definition_hash").notNull(),
  actorHash: varchar("actor_hash").notNull(),
  activatedAt: text("activated_at").notNull(),
}, (table) => [
  index("mint_definition_activations_collection_idx").on(table.collectionId, table.activatedAt),
  index("mint_definition_activation_target_idx").on(table.toDefinitionVersionId),
]);

// Phase 5 discovery is evidence, never authority. Resolver output can prefill
// a draft, but only the existing certification lifecycle can make it live.
export const mintResolverRuns = pgTable("mint_resolver_runs", {
  id: varchar("id").primaryKey(),
  resolverKey: varchar("resolver_key").notNull(),
  resolverVersion: varchar("resolver_version").notNull(),
  chainId: integer("chain_id").notNull(),
  contractAddress: varchar("contract_address").notNull(),
  status: varchar("status").notNull(), // resolved | needs-input | unsupported
  requestHash: varchar("request_hash").notNull(),
  resultJson: text("result_json").notNull(),
  resultHash: varchar("result_hash").notNull(),
  blockNumber: integer("block_number"),
  blockHash: varchar("block_hash"),
  contractCodeHash: varchar("contract_code_hash"),
  createdAt: text("created_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_resolver_runs_result_hash_unique").on(table.resultHash),
  index("mint_resolver_runs_contract_idx").on(table.chainId, table.contractAddress, table.createdAt),
]);

// Phase 6 keeps legacy execution as the authority until a certified candidate
// has enough exact intent matches. A mismatch can never be waived by a count.
export const mintCutoverStates = pgTable("mint_cutover_states", {
  collectionId: varchar("collection_id").primaryKey().references(() => collections.id),
  legacyAdapterKey: varchar("legacy_adapter_key").notNull(),
  candidateDefinitionVersionId: varchar("candidate_definition_version_id").notNull().references(() => mintDefinitionVersions.id),
  auditCycle: integer("audit_cycle").notNull().default(1),
  status: varchar("status").notNull().default("shadow"), // shadow | ready | cutover | rollback
  requiredSamples: integer("required_samples").notNull().default(20),
  matchedCount: integer("matched_count").notNull().default(0),
  mismatchedCount: integer("mismatched_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  lastComparisonAt: text("last_comparison_at"),
  reason: text("reason"),
  createdAt: text("created_at").notNull().default(sql`now()`),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [index("mint_cutover_candidate_idx").on(table.candidateDefinitionVersionId)]);

// ─── Mint Jobs ─────────────────────────────────────────────────────────
export const mintJobs = pgTable("mint_jobs", {
  id: varchar("id").primaryKey(), // uuid
  walletId: varchar("wallet_id")
    .notNull()
    .references(() => wallets.id),
  collectionId: varchar("collection_id")
    .notNull()
    .references(() => collections.id),
  definitionVersionId: varchar("definition_version_id").references(() => mintDefinitionVersions.id),
  definitionHash: varchar("definition_hash"),
  definitionSnapshot: text("definition_snapshot"),
  eligibilityArtifactId: varchar("eligibility_artifact_id").references(() => mintEligibilityArtifacts.id),
  eligibilityArtifactHash: varchar("eligibility_artifact_hash"),
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
  armedAt: text("armed_at"),
  launchTargetAt: text("launch_target_at"),
  preflightCheckedAt: text("preflight_checked_at"),
  timerFiredAt: text("timer_fired_at"),
  timingDriftMs: integer("timing_drift_ms"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  idempotencyKey: varchar("idempotency_key").unique(),
  batchId: varchar("batch_id"),
  phaseId: varchar("phase_id"),
  phaseStartsAt: text("phase_starts_at"),
  phaseEndsAt: text("phase_ends_at"),
  claimedAt: text("claimed_at"),
  leaseExpiresAt: text("lease_expires_at"),
  claimToken: varchar("claim_token"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [
  index("mint_jobs_status_schedule_idx").on(table.status, table.scheduledAt),
  index("mint_jobs_wallet_status_idx").on(table.walletId, table.status),
  index("mint_jobs_batch_idx").on(table.batchId),
]);

// ─── Mint Attempts (Transaction Log) ───────────────────────────────────
export const mintAttempts = pgTable("mint_attempts", {
  id: varchar("id").primaryKey(), // uuid
  jobId: varchar("job_id")
    .notNull()
    .references(() => mintJobs.id),
  txHash: text("tx_hash"),
  status: varchar("status").notNull(), // simulated | prepared | submitted | confirming | confirmed | failed
  kind: varchar("kind").notNull().default("mint"), // approval | mint
  nonce: integer("nonce"),
  toAddress: text("to_address"),
  value: text("value").notNull().default("0"),
  dataHash: text("data_hash"),
  gasLimit: text("gas_limit"),
  maxFeePerGas: text("max_fee_per_gas"),
  maxPriorityFeePerGas: text("max_priority_fee_per_gas"),
  gasUsed: text("gas_used"),
  effectiveGasPrice: text("effective_gas_price"),
  blockNumber: integer("block_number"),
  error: text("error"),
  rawTx: text("raw_tx"),
  preflightHash: text("preflight_hash"),
  preparedAt: text("prepared_at"),
  broadcastAt: text("broadcast_at"),
  confirmedAt: text("confirmed_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
}, (table) => [
  index("mint_attempts_job_idx").on(table.jobId),
  index("mint_attempts_tx_hash_idx").on(table.txHash),
]);

// ─── Settings (global key-value) ───────────────────────────────────────
export const settings = pgTable("settings", {
  key: varchar("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

// Per-route launch telemetry. Endpoint URLs are intentionally never stored:
// provider URLs commonly contain API credentials.
export const mintBroadcasts = pgTable("mint_broadcasts", {
  id: varchar("id").primaryKey(),
  attemptId: varchar("attempt_id").notNull().references(() => mintAttempts.id),
  routeKey: varchar("route_key").notNull(),
  routeLabel: varchar("route_label").notNull(),
  status: varchar("status").notNull(), // accepted | known | rejected | timeout | error
  latencyMs: integer("latency_ms"),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at").notNull(),
}, (table) => [
  index("mint_broadcasts_attempt_idx").on(table.attemptId),
  index("mint_broadcasts_route_idx").on(table.routeKey, table.startedAt),
]);

// Fine-grained launch telemetry. Durations are measured with the monotonic
// clock while timestamps retain wall-clock correlation for incident replay.
// Writes are queued off the transaction hot path by launch-telemetry.ts.
export const mintStageEvents = pgTable("mint_stage_events", {
  id: varchar("id").primaryKey(),
  jobId: varchar("job_id").notNull().references(() => mintJobs.id),
  attemptId: varchar("attempt_id").references(() => mintAttempts.id),
  stage: varchar("stage").notNull(),
  outcome: varchar("outcome").notNull(), // success | error | suppressed
  durationMs: integer("duration_ms").notNull(),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at").notNull(),
}, (table) => [
  index("mint_stage_events_job_idx").on(table.jobId, table.startedAt),
  index("mint_stage_events_stage_idx").on(table.stage, table.startedAt),
]);

export const mintShadowComparisons = pgTable("mint_shadow_comparisons", {
  id: varchar("id").primaryKey(),
  collectionId: varchar("collection_id").notNull().references(() => collections.id),
  candidateDefinitionVersionId: varchar("candidate_definition_version_id").notNull().references(() => mintDefinitionVersions.id),
  auditCycle: integer("audit_cycle").notNull().default(1),
  jobId: varchar("job_id").notNull().references(() => mintJobs.id),
  phaseId: varchar("phase_id").notNull(),
  walletAddressHash: varchar("wallet_address_hash").notNull(),
  quantity: integer("quantity").notNull(),
  legacyIntentHash: varchar("legacy_intent_hash"),
  candidateIntentHash: varchar("candidate_intent_hash"),
  status: varchar("status").notNull(), // match | mismatch | error
  diffJson: text("diff_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_shadow_comparison_job_candidate_phase_cycle_unique").on(table.jobId, table.candidateDefinitionVersionId, table.phaseId, table.auditCycle),
  index("mint_shadow_comparison_collection_idx").on(table.collectionId, table.createdAt),
]);

export const mintIncidentBundles = pgTable("mint_incident_bundles", {
  id: varchar("id").primaryKey(),
  jobId: varchar("job_id").notNull().references(() => mintJobs.id),
  trigger: varchar("trigger").notNull(),
  bundleJson: text("bundle_json").notNull(),
  bundleHash: varchar("bundle_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("mint_incident_bundles_hash_unique").on(table.bundleHash),
  index("mint_incident_bundles_job_idx").on(table.jobId, table.createdAt),
]);

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
  idempotencyKey: varchar("idempotency_key").unique(),
  requestHash: text("request_hash"),
  previewJson: text("preview_json"),
  amountPerWallet: text("amount_per_wallet"),
  error: text("error"),
  claimedAt: text("claimed_at"),
  leaseExpiresAt: text("lease_expires_at"),
  claimToken: varchar("claim_token"),
  createdAt: text("created_at").notNull().default(sql`now()`),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull().default(sql`now()`),
}, (table) => [
  index("disperse_operations_status_idx").on(table.status, table.createdAt),
]);

export const disperseTransfers = pgTable("disperse_transfers", {
  id: varchar("id").primaryKey(),
  operationId: varchar("operation_id").notNull().references(() => disperseOperations.id),
  fromWalletId: varchar("from_wallet_id").notNull().references(() => wallets.id),
  toWalletId: varchar("to_wallet_id").notNull().references(() => wallets.id),
  amount: text("amount").notNull(),
  status: varchar("status").notNull().default("pending"),
  nonce: integer("nonce"),
  gasLimit: text("gas_limit"),
  maxFeePerGas: text("max_fee_per_gas"),
  maxPriorityFeePerGas: text("max_priority_fee_per_gas"),
  gasUsed: text("gas_used"),
  effectiveGasPrice: text("effective_gas_price"),
  blockNumber: integer("block_number"),
  txHash: text("tx_hash"),
  rawTx: text("raw_tx"),
  error: text("error"),
  preparedAt: text("prepared_at"),
  broadcastAt: text("broadcast_at"),
  confirmedAt: text("confirmed_at"),
  createdAt: text("created_at").notNull().default(sql`now()`),
}, (table) => [
  index("disperse_transfers_operation_idx").on(table.operationId),
  index("disperse_transfers_tx_hash_idx").on(table.txHash),
]);
