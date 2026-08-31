import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getMintAdapter } from "@/lib/adapters";
import { executionEngineFor, executionManifestFor } from "@/lib/engines";
import { competitiveFeeFields, reviewedFallbackGasLimit } from "@/lib/gas-policy";
import type { MintPhase, SupportedCollection } from "@/lib/adapters/types";
import { isTransientRpcReadError, manualOpenRetryAt, recoveredJobStatus } from "@/lib/mint-policy";
import { inspectWalletPhases, resolveWalletPhasePlan, resolveWalletSelectedPhase } from "@/lib/phase-planning";
import { mintWalletEligibilityError } from "@/lib/mint-wallet-policy";
import { recordMintSuppression, traceMintStage } from "@/lib/launch-telemetry";
import { getProvider } from "@/lib/chains";
import { broadcastSameHash, warmBroadcastRoutes } from "@/lib/chains/broadcast";
import { sendPrivateTransaction, hasFlashbotsProtect } from "@/lib/chains/flashbots";
import { sendAlert } from "@/lib/alerting";
import { getSigner } from "@/lib/vault";
import {
  exactSimulationRequest,
  prepareSignedTransactionBatch,
  prepareSignedTransaction,
} from "@/lib/transactions";
import {
  isPermanentMintError,
  liveTransactionsEnabled,
  requireLiveTransactions,
  safeErrorMessage,
  stableHash,
} from "@/lib/safety";
import {
  assertMintControls,
  scheduleMintDefinition,
  validatedJobCollection,
} from "@/lib/mint-definitions";
import { MINT_ERROR_CODES, mintErrorCode } from "@/lib/mint-errors";
import { recordShadowMintIntent } from "@/lib/mint-cutover";
import { createIncidentReplayBundle } from "@/lib/incident-replay";
import { openSignedTransaction, sealSignedTransaction } from "@/lib/signed-transaction-vault";

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const SEADROP_ERRORS = new ethers.Interface([
  "error MintQuantityExceedsMaxSupply(uint256 total,uint256 maxSupply)",
  "error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total,uint256 maxSupply)",
  "error MintQuantityExceedsMaxMintedPerWallet(uint256 total,uint256 maxPerWallet)",
]);

function nestedRevertData(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.data === "string" && ethers.isHexString(record.data) && record.data.length >= 10) return record.data;
  return nestedRevertData(record.error, seen) || nestedRevertData(record.info, seen) || nestedRevertData(record.cause, seen);
}

export function explainMintSimulationError(error: unknown): string | undefined {
  const data = nestedRevertData(error);
  if (!data) return undefined;
  try {
    const parsed = SEADROP_ERRORS.parseError(data);
    if (!parsed) return undefined;
    const total = parsed.args[0].toString();
    const maximum = parsed.args[1].toString();
    if (parsed.name === "MintQuantityExceedsMaxSupply") return `Collection sold out: requested supply ${total} exceeds maximum ${maximum}`;
    if (parsed.name === "MintQuantityExceedsMaxTokenSupplyForStage") return `Mint stage sold out: requested supply ${total} exceeds stage maximum ${maximum}`;
    if (parsed.name === "MintQuantityExceedsMaxMintedPerWallet") return `Wallet mint limit reached: requested total ${total} exceeds wallet maximum ${maximum}`;
  } catch { return undefined; }
  return undefined;
}

const JOB_LEASE_MS = 120_000;

class MintNotOpenError extends Error {
  constructor(readonly scheduledAt: string, readonly phaseStartsAt: string | null = scheduledAt) {
    super(`Mint is scheduled for ${scheduledAt}`);
  }
}

type JobRow = typeof schema.mintJobs.$inferSelect;
type AttemptRow = typeof schema.mintAttempts.$inferSelect;

function jobAdapterOptions(job: JobRow, phaseId: string, allowBeforeStart = false) {
  return {
    phaseId,
    allowBeforeStart,
    eligibilityArtifactId: job.eligibilityArtifactId,
    eligibilityArtifactHash: job.eligibilityArtifactHash,
  };
}

type ExecutionResult = {
  status: "confirmed" | "failed" | "confirming" | "simulation_passed" | "armed";
  txHash?: string;
  error?: string;
  dryRun?: boolean;
  gasUsed?: string;
  effectiveGasPrice?: string;
  blockNumber?: number;
  launchTargetAt?: string;
};

async function resolvePhase(collection: SupportedCollection, signerAddress: string, quantity: number, phaseId: string | null, signer?: ethers.Signer): Promise<MintPhase> {
  if (phaseId) return (await resolveWalletSelectedPhase(collection, signerAddress, quantity, phaseId, undefined, { signer })).selectedPhase;
  return (await resolveWalletPhasePlan(collection, signerAddress, quantity, undefined, { signer })).selectedPhase;
}

async function loadExecutionState(jobId: string) {
  const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
  if (!job) throw new Error(`Mint job ${jobId} was not found`);
  const [[collectionControl], [wallet]] = await Promise.all([
    db.select().from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1),
    db.select().from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1),
  ]);
  if (!collectionControl || !collectionControl.active || !collectionControl.verified) throw new Error("Mint support is disabled or no longer verified");
  await assertMintControls(collectionControl, job.phaseId);
  const collection = await validatedJobCollection(collectionControl, job);
  // Re-validate at execution time as well as discovery time. A stale queued
  // task must not bypass a manifest edit or accidentally enter a different
  // launch strategy after deployment.
  executionManifestFor(collection);
  executionEngineFor(collection);
  if (!wallet) throw new Error("Selected mint wallet was not found");
  const [parent] = wallet.role === "worker" && wallet.parentWalletId
    ? await db.select().from(schema.wallets).where(eq(schema.wallets.id, wallet.parentWalletId)).limit(1)
    : [];
  const eligibilityError = mintWalletEligibilityError(wallet, collection.chainId, parent);
  if (eligibilityError) throw new Error(eligibilityError);
  return { job, collection, wallet };
}

async function applyGas(
  request: ethers.TransactionRequest,
  provider: ethers.Provider,
  from: string,
  overrides?: Pick<JobRow, "gasLimit" | "maxFeePerGas" | "maxPriorityFeePerGas">,
  fallbackGasLimit?: bigint,
  estimate = true,
): Promise<ethers.TransactionRequest> {
  const exact = exactSimulationRequest(request, from);
  const [estimatedResult, fees] = await Promise.all([
    estimate ? provider.estimateGas(exact)
      .then((value): { ok: true; value: bigint } => ({ ok: true, value }))
      .catch((error: unknown): { ok: false; error: unknown } => ({ ok: false, error }))
      : Promise.resolve(fallbackGasLimit != null ? { ok: true as const, value: fallbackGasLimit } : { ok: false as const, error: new Error("A reviewed gas limit is required when launch-time estimation is disabled") }),
    provider.getFeeData(),
  ]);
  const estimated = estimatedResult.ok ? estimatedResult.value : fallbackGasLimit;
  if (!estimated) throw estimatedResult.ok ? new Error("Gas estimation failed") : estimatedResult.error;
  const gasLimit = overrides?.gasLimit ? BigInt(overrides.gasLimit) : (estimated * 120n) / 100n;
  const result: ethers.TransactionRequest = { ...request, gasLimit };
  const chainId = Number(request.chainId);
  const automaticFees = competitiveFeeFields(chainId, fees);
  if (overrides?.maxFeePerGas) result.maxFeePerGas = BigInt(overrides.maxFeePerGas);
  else if (automaticFees.maxFeePerGas != null) result.maxFeePerGas = automaticFees.maxFeePerGas;
  if (overrides?.maxPriorityFeePerGas) result.maxPriorityFeePerGas = BigInt(overrides.maxPriorityFeePerGas);
  else if (automaticFees.maxPriorityFeePerGas != null) result.maxPriorityFeePerGas = automaticFees.maxPriorityFeePerGas;
  if (result.maxFeePerGas == null && automaticFees.gasPrice != null) result.gasPrice = automaticFees.gasPrice;
  return result;
}

async function simulateExact(request: ethers.TransactionRequest, provider: ethers.Provider, from: string): Promise<void> {
  try {
    await provider.call(exactSimulationRequest(request, from));
  } catch (error) {
    throw new Error(explainMintSimulationError(error) || `Exact wallet simulation failed: ${safeErrorMessage(error, "transaction reverted")}`);
  }
}

function maximumGasCost(request: ethers.TransactionRequest): bigint {
  const gasLimit = BigInt(request.gasLimit ?? 0);
  const fee = BigInt(request.maxFeePerGas ?? request.gasPrice ?? 0);
  return gasLimit * fee;
}

async function assertBalanceAndSpendLimit(
  walletId: string,
  address: string,
  request: ethers.TransactionRequest,
  provider: ethers.Provider,
  current?: { jobId: string; kind: "approval" | "mint" },
): Promise<void> {
  const required = BigInt(request.value ?? 0) + maximumGasCost(request);
  const balance = await provider.getBalance(address);
  if (balance < required) {
    throw new Error(`Insufficient native balance: have ${ethers.formatEther(balance)}, need up to ${ethers.formatEther(required)}`);
  }

  const [wallet] = await db.select({ spendLimit: schema.wallets.spendLimit }).from(schema.wallets)
    .where(eq(schema.wallets.id, walletId)).limit(1);
  if (!wallet?.spendLimit) return;
  const chainId = Number(request.chainId);
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("Transaction chain is unavailable for spend-limit enforcement");
  const rows = await db.execute(sql<{ total: string }>`
    select coalesce(sum(
      cast(a.value as numeric) +
      case when a.status = 'confirmed'
        then coalesce(cast(a.gas_used as numeric), 0) * coalesce(cast(a.effective_gas_price as numeric), 0)
        else coalesce(cast(a.gas_limit as numeric), 0) * coalesce(cast(a.max_fee_per_gas as numeric), 0)
      end
    ), 0)::text as total
    from mint_attempts a
    join mint_jobs j on j.id = a.job_id
    join collections c on c.id = j.collection_id
    where j.wallet_id = ${walletId}
      and c.chain_id = ${chainId}
      and a.status in ('prepared', 'submitted', 'confirming', 'confirmed')
      ${current ? sql`and not (a.job_id = ${current.jobId} and a.kind = ${current.kind})` : sql``}
  `);
  const [{ total = "0" } = {}] = rows as unknown as Array<{ total?: string }>;
  const reservedOrSpent = BigInt(total);
  if (reservedOrSpent + required > BigInt(wallet.spendLimit)) {
    throw new Error("Mint wallet spend limit would be exceeded");
  }
}

async function latestRecoverableAttempt(jobId: string, kind: "approval" | "mint"): Promise<AttemptRow | undefined> {
  const [attempt] = await db.select().from(schema.mintAttempts)
    .where(and(eq(schema.mintAttempts.jobId, jobId), eq(schema.mintAttempts.kind, kind)))
    .orderBy(desc(schema.mintAttempts.createdAt)).limit(1);
  return attempt && attempt.txHash && attempt.rawTx && ["prepared", "submitted", "confirming"].includes(attempt.status)
    ? { ...attempt, rawTx: openSignedTransaction(attempt.rawTx) }
    : undefined;
}

function transactionIntentHash(request: ethers.TransactionRequest): string {
  return stableHash({
    chainId: Number(request.chainId),
    to: String(request.to || "").toLowerCase(),
    data: String(request.data || "0x").toLowerCase(),
    value: BigInt(request.value ?? 0).toString(),
  });
}

async function prepareDurableAttempt(args: {
  job: JobRow;
  kind: "approval" | "mint";
  request: ethers.TransactionRequest;
  signer: ethers.Signer;
  provider: ethers.Provider;
}): Promise<AttemptRow> {
  const { job, kind, request, signer, provider } = args;
  const existing = await latestRecoverableAttempt(job.id, kind);
  if (existing) {
    if (existing.preflightHash !== transactionIntentHash(request)) throw new Error("Stored prepared transaction no longer matches the current reviewed mint intent");
    const parsed = ethers.Transaction.from(existing.rawTx!);
    if (transactionIntentHash(parsed) !== transactionIntentHash(request)) throw new Error("Stored signed transaction does not match the current reviewed mint intent");
    return existing;
  }
  const attemptId = randomUUID();
  const intentHash = transactionIntentHash(request);
  const prepared = await traceMintStage(job.id, "signing", () => prepareSignedTransaction(
    job.walletId,
    Number(request.chainId),
    signer,
    provider,
    request,
    async (signed, tx) => {
      await tx.insert(schema.mintAttempts).values({
        id: attemptId,
        jobId: job.id,
        kind,
        status: "prepared",
        nonce: signed.nonce,
        txHash: signed.txHash,
        rawTx: sealSignedTransaction(signed.rawTx),
        toAddress: String(signed.request.to || ""),
        value: BigInt(signed.request.value ?? 0).toString(),
        dataHash: stableHash(String(signed.request.data || "0x")),
        preflightHash: intentHash,
        gasLimit: signed.request.gasLimit?.toString() || null,
        maxFeePerGas: signed.request.maxFeePerGas?.toString() || signed.request.gasPrice?.toString() || null,
        maxPriorityFeePerGas: signed.request.maxPriorityFeePerGas?.toString() || null,
        preparedAt: new Date().toISOString(),
      });
    },
  ));
  const [attempt] = await db.select().from(schema.mintAttempts).where(eq(schema.mintAttempts.id, attemptId)).limit(1);
  if (!attempt) throw new Error("Prepared transaction was not durably recorded");
  if (attempt.txHash?.toLowerCase() !== prepared.txHash.toLowerCase()) throw new Error("Prepared transaction hash mismatch");
  const parsed = ethers.Transaction.from(prepared.rawTx);
  if (transactionIntentHash(parsed) !== intentHash) throw new Error("Signed transaction does not match the reviewed mint intent");
  return attempt;
}

async function sendDurableAttempt(args: {
  job: JobRow;
  kind: "approval" | "mint";
  request: ethers.TransactionRequest;
  signer: ethers.Signer;
  provider: ethers.Provider;
}): Promise<ExecutionResult> {
  const { job, kind, request, signer, provider } = args;
  const attempt = await prepareDurableAttempt({ job, kind, request, signer, provider });

  const receiptBeforeBroadcast = await traceMintStage(job.id, "receipt", () => provider.getTransactionReceipt(attempt.txHash!).catch(() => null), attempt.id);
  if (receiptBeforeBroadcast) return finalizeAttempt(attempt.id, receiptBeforeBroadcast);

  requireLiveTransactions();
  let ambiguousBroadcast = false;
  try {
    if (job.useFlashbots && hasFlashbotsProtect(Number(request.chainId))) {
      const response = await sendPrivateTransaction(Number(request.chainId), attempt.rawTx!);
      if (response.hash.toLowerCase() !== attempt.txHash!.toLowerCase()) throw new Error("Private relay returned an unexpected hash");
    } else {
      const outcome = await traceMintStage(job.id, "broadcast", () => broadcastSameHash({
        attemptId: attempt.id,
        chainId: Number(request.chainId),
        rawTx: attempt.rawTx!,
        expectedHash: attempt.txHash!,
      }), attempt.id);
      const ambiguous = outcome.results.some((result) => result.status === "timeout" || result.status === "error");
      ambiguousBroadcast = !outcome.accepted && ambiguous;
      if (!outcome.accepted && !ambiguous) {
        throw new Error(outcome.results.map((result) => result.error).filter(Boolean).join("; ") || "Every broadcast route rejected the transaction");
      }
    }
    await db.update(schema.mintAttempts).set({ status: "submitted", broadcastAt: new Date().toISOString(), error: ambiguousBroadcast ? "Broadcast acknowledgement was ambiguous; reconciling by hash" : null })
      .where(eq(schema.mintAttempts.id, attempt.id));
  } catch (error) {
    const existing = await provider.getTransaction(attempt.txHash!).catch(() => null);
    await db.update(schema.mintAttempts).set({
      status: existing ? "submitted" : "prepared",
      broadcastAt: existing ? new Date().toISOString() : attempt.broadcastAt,
      error: safeErrorMessage(error, "Broadcast failed; the same signed transaction will be reconciled"),
    }).where(eq(schema.mintAttempts.id, attempt.id));
    if (!existing) throw error;
  }
  return { status: "confirming", txHash: attempt.txHash! };
}

async function executeOnePerTransactionLadder(args: {
  job: JobRow;
  collection: SupportedCollection;
  wallet: typeof schema.wallets.$inferSelect;
  phase: MintPhase;
  signer: ethers.Signer;
  provider: ethers.Provider;
}): Promise<ExecutionResult | null> {
  const { job, collection, wallet, phase, signer, provider } = args;
  const manifest = executionManifestFor(collection);
  const engine = executionEngineFor(collection);
  if (!manifest.onePerTransaction || !job.batchId || !job.phaseId) return null;
  const siblings = await db.select().from(schema.mintJobs).where(and(
    eq(schema.mintJobs.batchId, job.batchId), eq(schema.mintJobs.walletId, job.walletId),
    eq(schema.mintJobs.collectionId, job.collectionId), eq(schema.mintJobs.phaseId, job.phaseId),
    inArray(schema.mintJobs.status, ["pending", "running"]),
  )).orderBy(asc(schema.mintJobs.createdAt), asc(schema.mintJobs.id)).limit(manifest.maxPreparedTransactions || 1);
  if (siblings.length <= 1) return null;
  if (engine.requiresDedicatedWalletForLadder && wallet.role !== "worker") {
    throw new Error("Multi-transaction launch mode requires a dedicated worker wallet");
  }
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter?.buildTransaction || !adapter.remainingTransactions) throw new Error("This one-per-transaction adapter cannot prove ladder capacity");
  const address = await signer.getAddress();
  const capacity = await traceMintStage(job.id, "final-revalidation", () => adapter.remainingTransactions!(collection, phase.id, address, provider));
  const selected = siblings.slice(0, Math.max(0, capacity));
  const suppressed = siblings.slice(selected.length);
  if (suppressed.length) {
    const reason = `Suppressed before signing: authoritative wallet/supply capacity is ${capacity}`;
    const now = new Date().toISOString();
    await db.update(schema.mintJobs).set({ status: "failed", error: reason, completedAt: now, updatedAt: now })
      .where(inArray(schema.mintJobs.id, suppressed.map((item) => item.id)));
    for (const item of suppressed) recordMintSuppression(item.id, "final-revalidation", reason);
  }
  if (!selected.length) throw new Error("No safe mint capacity remains for this wallet");

  let request = await traceMintStage(job.id, "payload-acquisition", () => adapter.buildTransaction!(collection, address, 1, provider, jobAdapterOptions(job, phase.id)));
  void recordShadowMintIntent({ jobId: job.id, collection, walletAddress: address, quantity: 1, phaseId: phase.id, provider, legacyRequest: request })
    .catch(() => undefined);
  request = await traceMintStage(job.id, "gas-preparation", () => applyGas(request, provider, address, job, adapter.recommendedGasLimit, engine.launchTimeGasEstimation));
  await traceMintStage(job.id, "simulation", () => simulateExact(request, provider, address));
  if (adapter.revalidateBeforeSigning) {
    await traceMintStage(job.id, "final-revalidation", () => adapter.revalidateBeforeSigning!(collection, address, 1, provider, request, { phaseId: phase.id }));
  }
  const aggregate = {
    ...request,
    value: BigInt(request.value ?? 0) * BigInt(selected.length),
    gasLimit: BigInt(request.gasLimit ?? 0) * BigInt(selected.length),
  };
  await assertBalanceAndSpendLimit(job.walletId, address, aggregate, provider);
  const attemptIds = selected.map(() => randomUUID());
  const requests = selected.map(() => ({ ...request }));
  const prepared = await traceMintStage(job.id, "signing", () => prepareSignedTransactionBatch(
    job.walletId, collection.chainId, signer, provider, requests,
    async (items, tx) => {
      await tx.insert(schema.mintAttempts).values(items.map((item, index) => ({
        id: attemptIds[index], jobId: selected[index]!.id, kind: "mint", status: "prepared",
        nonce: item.nonce, txHash: item.txHash, rawTx: sealSignedTransaction(item.rawTx),
        toAddress: String(item.request.to || ""), value: BigInt(item.request.value ?? 0).toString(),
        dataHash: stableHash(String(item.request.data || "0x")), preflightHash: transactionIntentHash(item.request),
        gasLimit: item.request.gasLimit?.toString() || null,
        maxFeePerGas: item.request.maxFeePerGas?.toString() || item.request.gasPrice?.toString() || null,
        maxPriorityFeePerGas: item.request.maxPriorityFeePerGas?.toString() || null,
        preparedAt: new Date().toISOString(),
      })));
    },
  ));
  requireLiveTransactions();
  const results = await Promise.all(prepared.map((item, index) => traceMintStage(selected[index]!.id, "broadcast", () => broadcastSameHash({
    attemptId: attemptIds[index]!, chainId: collection.chainId, rawTx: item.rawTx, expectedHash: item.txHash,
  }), attemptIds[index])));
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (let index = 0; index < selected.length; index += 1) {
      const outcome = results[index]!;
      const ambiguous = outcome.results.some((result) => result.status === "timeout" || result.status === "error");
      const accepted = outcome.accepted || ambiguous;
      await tx.update(schema.mintAttempts).set({
        status: accepted ? "submitted" : "failed", broadcastAt: now,
        error: outcome.accepted ? null : ambiguous ? "Broadcast acknowledgement was ambiguous; reconciling by hash" : outcome.results.map((item) => item.error).filter(Boolean).join("; "),
      }).where(eq(schema.mintAttempts.id, attemptIds[index]!));
      await tx.update(schema.mintJobs).set({
        status: accepted ? "confirming" : "failed", updatedAt: now,
        completedAt: accepted ? null : now, leaseExpiresAt: accepted ? leaseExpiry() : null,
        error: outcome.accepted ? null : ambiguous ? "Broadcast acknowledgement was ambiguous; reconciling by hash" : "Every route rejected the prepared transaction",
      }).where(eq(schema.mintJobs.id, selected[index]!.id));
    }
  });
  return { status: "confirming", txHash: prepared[0]!.txHash };
}

async function finalizeAttempt(attemptId: string, receipt: ethers.TransactionReceipt): Promise<ExecutionResult> {
  const confirmed = receipt.status === 1;
  await db.update(schema.mintAttempts).set({
    status: confirmed ? "confirmed" : "failed",
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.gasPrice.toString(),
    blockNumber: receipt.blockNumber,
    confirmedAt: new Date().toISOString(),
    rawTx: null,
    error: confirmed ? null : "Transaction receipt reported failure",
  }).where(eq(schema.mintAttempts.id, attemptId));
  return {
    status: confirmed ? "confirmed" : "failed",
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.gasPrice.toString(),
    error: confirmed ? undefined : "Transaction receipt reported failure",
  };
}

async function ensureErc20Approval(
  job: JobRow,
  collection: SupportedCollection,
  phase: MintPhase,
  request: ethers.TransactionRequest,
  signer: ethers.Signer,
  provider: ethers.Provider,
): Promise<ExecutionResult | null> {
  if (!collection.paymentToken) return null;
  const owner = await signer.getAddress();
  const spender = String(request.to || collection.contractAddress);
  if (!phase.priceWei || !/^\d+$/.test(phase.priceWei)) throw new Error("Selected payment-token phase has no exact reviewed unit price");
  const needed = BigInt(phase.priceWei) * BigInt(job.quantity);
  if (needed <= 0n) throw new Error("Selected payment-token phase requires a positive reviewed approval amount");
  const token = new ethers.Contract(collection.paymentToken, ERC20_ABI, provider);
  const [balance, allowance] = await Promise.all([
    token.getFunction("balanceOf").staticCall(owner).then(BigInt),
    token.getFunction("allowance").staticCall(owner, spender).then(BigInt),
  ]);
  if (balance < needed) throw new Error("Insufficient payment-token balance");
  if (allowance >= needed) return null;
  if (job.dryRun) throw new Error("Dry run requires a payment-token approval before exact mint simulation");

  const approvalData = new ethers.Interface(ERC20_ABI).encodeFunctionData("approve", [spender, needed]);
  let approval = await applyGas({ to: collection.paymentToken, data: approvalData, value: 0n, chainId: collection.chainId }, provider, owner);
  await simulateExact(approval, provider, owner);
  await assertBalanceAndSpendLimit(job.walletId, owner, approval, provider, { jobId: job.id, kind: "approval" });
  approval = { ...approval, chainId: collection.chainId };
  const result = await sendDurableAttempt({ job, kind: "approval", request: approval, signer, provider });
  if (result.status !== "confirmed") return result;
  return null;
}

async function armMint(
  job: JobRow,
  collection: SupportedCollection,
  phase: MintPhase,
): Promise<ExecutionResult> {
  if (!phase.startsAt) throw new Error("Upcoming mint has no reviewed contract start time");
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter?.buildTransaction || !adapter.supportsArming || (adapter.canArmPhase && !adapter.canArmPhase(phase.id))) {
    throw new MintNotOpenError(phase.startsAt);
  }
  const provider = getProvider(collection.chainId);
  const engine = executionEngineFor(collection);
  const signer = await getSigner(job.walletId, provider);
  const address = await signer.getAddress();
  let request = await traceMintStage(job.id, "payload-acquisition", () => adapter.buildTransaction!(collection, address, job.quantity, provider, jobAdapterOptions(job, phase.id, true)));
  void recordShadowMintIntent({ jobId: job.id, collection, walletAddress: address, quantity: job.quantity, phaseId: phase.id, provider, legacyRequest: request, allowBeforeStart: true })
    .catch(() => undefined);
  const fallbackGasLimit = reviewedFallbackGasLimit(collection.chainId, collection.adapterKey, job.quantity, adapter.recommendedGasLimit);
  request = await traceMintStage(job.id, "gas-preparation", () => applyGas(request, provider, address, job, fallbackGasLimit, engine.launchTimeGasEstimation));
  const approvalResult = await ensureErc20Approval(job, collection, phase, request, signer, provider);
  if (approvalResult) return approvalResult;
  await assertBalanceAndSpendLimit(job.walletId, address, request, provider, { jobId: job.id, kind: "mint" });
  const attempt = await prepareDurableAttempt({ job, kind: "mint", request, signer, provider });
  if (!attempt.rawTx || !attempt.txHash) throw new Error("Armed transaction payload is unavailable");
  const now = new Date().toISOString();
  await db.update(schema.mintJobs).set({
    status: "armed",
    armedAt: now,
    launchTargetAt: phase.startsAt,
    preflightCheckedAt: now,
    phaseStartsAt: phase.startsAt,
    phaseEndsAt: phase.endsAt || null,
    claimToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    updatedAt: now,
    error: null,
  }).where(eq(schema.mintJobs.id, job.id));
  await warmBroadcastRoutes(collection.chainId);
  return { status: "armed", txHash: attempt.txHash, launchTargetAt: phase.startsAt };
}

export async function revalidateArmedJob(jobId: string): Promise<void> {
  const { job, collection, wallet } = await loadExecutionState(jobId);
  if (job.status !== "armed" || !job.launchTargetAt) return;
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter?.buildTransaction || !adapter.supportsArming || !job.phaseId || (adapter.canArmPhase && !adapter.canArmPhase(job.phaseId))) throw new Error("Armed adapter is unavailable for this phase");
  const provider = getProvider(collection.chainId);
  const signer = await getSigner(job.walletId, provider);
  if (!adapter.prearmedPayloadProvesEligibility?.(collection, job.phaseId)) {
    const plan = await traceMintStage(job.id, "final-revalidation", () => inspectWalletPhases(collection, wallet.address, job.quantity, undefined, { signer }));
    const phase = plan.phases.find((item) => item.id === job.phaseId);
    const eligibility = plan.eligibility.find((item) => item.phaseId === job.phaseId);
    if (!phase || eligibility?.status !== "eligible") throw new Error("The armed wallet is no longer eligible for its reviewed phase");
    if (phase.status === "ended") throw new Error("The reviewed mint phase ended before launch");
    if (phase.startsAt !== job.launchTargetAt) throw new Error("The on-chain launch time changed after arming");
  }
  const address = await signer.getAddress();
  const request = await adapter.buildTransaction(collection, address, job.quantity, provider, jobAdapterOptions(job, job.phaseId, true));
  const attempt = await latestRecoverableAttempt(job.id, "mint");
  if (!attempt?.rawTx || !attempt.txHash || attempt.nonce == null) throw new Error("Armed transaction is missing");
  if (attempt.preflightHash !== transactionIntentHash(request)) throw new Error("Reviewed mint transaction changed after arming");
  let parsed = ethers.Transaction.from(attempt.rawTx);
  if (parsed.hash?.toLowerCase() !== attempt.txHash.toLowerCase()) throw new Error("Armed transaction hash no longer matches its payload");
  if (parsed.from?.toLowerCase() !== address.toLowerCase()) throw new Error("Armed transaction signer mismatch");
  const pendingNonce = await provider.getTransactionCount(address, "pending");
  if (pendingNonce !== attempt.nonce) throw new Error("Wallet nonce changed after arming; refusing a late or blocked launch");
  if (collection.chainId === 1) {
    const fallbackGasLimit = reviewedFallbackGasLimit(collection.chainId, collection.adapterKey, job.quantity, adapter.recommendedGasLimit);
    const refreshed = await traceMintStage(job.id, "gas-preparation", () => applyGas(
      request,
      provider,
      address,
      {
        gasLimit: job.gasLimit || attempt.gasLimit,
        maxFeePerGas: job.maxFeePerGas,
        maxPriorityFeePerGas: job.maxPriorityFeePerGas,
      },
      fallbackGasLimit,
      false,
    ));
    const populated = await signer.populateTransaction({ ...refreshed, nonce: attempt.nonce, chainId: collection.chainId });
    delete populated.from;
    const rawTx = await signer.signTransaction(populated);
    const txHash = ethers.keccak256(rawTx);
    parsed = ethers.Transaction.from(rawTx);
    if (transactionIntentHash(parsed) !== attempt.preflightHash) throw new Error("Ethereum fee refresh changed the reviewed mint intent");
    const updated = await db.update(schema.mintAttempts).set({
      rawTx: sealSignedTransaction(rawTx),
      txHash,
      gasLimit: parsed.gasLimit.toString(),
      maxFeePerGas: parsed.maxFeePerGas?.toString() || parsed.gasPrice?.toString() || null,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas?.toString() || null,
      preparedAt: new Date().toISOString(),
      error: null,
    }).where(and(
      eq(schema.mintAttempts.id, attempt.id),
      eq(schema.mintAttempts.status, "prepared"),
      eq(schema.mintAttempts.txHash, attempt.txHash),
    )).returning({ id: schema.mintAttempts.id });
    if (!updated.length) throw new Error("Ethereum armed transaction changed during final fee refresh");
  }
  await assertBalanceAndSpendLimit(job.walletId, address, parsed, provider, { jobId: job.id, kind: "mint" });
  await warmBroadcastRoutes(collection.chainId);
  await db.update(schema.mintJobs).set({ preflightCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null })
    .where(and(eq(schema.mintJobs.id, job.id), eq(schema.mintJobs.status, "armed")));
}

export async function failArmedJob(jobId: string, error: unknown): Promise<void> {
  const now = new Date().toISOString();
  await db.update(schema.mintJobs).set({
    status: "failed",
    error: safeErrorMessage(error, "Final launch revalidation failed"),
    completedAt: now,
    updatedAt: now,
  }).where(and(eq(schema.mintJobs.id, jobId), eq(schema.mintJobs.status, "armed")));
  await createIncidentReplayBundle(jobId, "armed-final-revalidation").catch(() => undefined);
}

export async function launchArmedJob(jobId: string, firedAt = Date.now()): Promise<ExecutionResult | undefined> {
  let { job, collection } = await loadExecutionState(jobId);
  if (job.status !== "armed" || !job.launchTargetAt) return;
  const checkedAt = job.preflightCheckedAt ? Date.parse(job.preflightCheckedAt) : 0;
  if (!checkedAt || firedAt - checkedAt > 15_000) {
    await revalidateArmedJob(jobId);
    ({ job, collection } = await loadExecutionState(jobId));
  }
  const attempt = await latestRecoverableAttempt(job.id, "mint");
  if (!attempt?.rawTx || !attempt.txHash) throw new Error("Armed transaction is missing at launch");
  const rawTx = attempt.rawTx;
  const txHash = attempt.txHash;
  requireLiveTransactions();

  // Network requests are fired before any launch-time database write. The raw
  // transaction and hash were already committed durably during arming.
  const outcome = await traceMintStage(job.id, "broadcast", () => broadcastSameHash({
    attemptId: attempt.id,
    chainId: collection.chainId,
    rawTx,
    expectedHash: txHash,
  }), attempt.id);
  const ambiguous = outcome.results.some((result) => result.status === "timeout" || result.status === "error");
  if (!outcome.accepted && !ambiguous) {
    throw new Error(outcome.results.map((result) => result.error).filter(Boolean).join("; ") || "Every broadcast route rejected the transaction");
  }
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(schema.mintAttempts).set({ status: "submitted", broadcastAt: now, error: outcome.accepted ? null : "Broadcast acknowledgement was ambiguous; reconciling by hash" })
      .where(eq(schema.mintAttempts.id, attempt.id));
    await tx.update(schema.mintJobs).set({
      status: "confirming",
      timerFiredAt: new Date(firedAt).toISOString(),
      timingDriftMs: Math.max(0, firedAt - Date.parse(job.launchTargetAt!)),
      leaseExpiresAt: leaseExpiry(),
      updatedAt: now,
      error: outcome.accepted ? null : "Broadcast acknowledgement was ambiguous; reconciling by hash",
    }).where(and(eq(schema.mintJobs.id, job.id), eq(schema.mintJobs.status, "armed")));
  });
  return { status: "confirming", txHash: attempt.txHash };
}

export async function executeMint(jobId: string): Promise<ExecutionResult> {
  const { job, collection, wallet } = await loadExecutionState(jobId);
  const provider = getProvider(collection.chainId);
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter) throw new Error("Mint adapter cannot resolve a reviewed transaction");
  if (job.phaseId && adapter.pollPhaseReady) {
    try {
      if (!(await traceMintStage(job.id, "open-detection", () => adapter.pollPhaseReady!(collection, job.phaseId!, provider)))) {
        recordMintSuppression(job.id, "open-detection", "The reviewed opening condition is not active yet");
        throw new MintNotOpenError(new Date(Date.now() + 250).toISOString(), null);
      }
    } catch (error) {
      if (error instanceof MintNotOpenError) throw error;
      if (isTransientRpcReadError(error)) {
        throw new MintNotOpenError(new Date(Date.now() + 250).toISOString(), null);
      }
      throw error;
    }
  }
  const signer = await getSigner(job.walletId, provider);
  const phase = await traceMintStage(job.id, "phase-resolution", () => resolvePhase(collection, wallet.address, job.quantity, job.phaseId, signer));
  if (job.phaseStartsAt !== (phase.startsAt || null) || job.phaseEndsAt !== (phase.endsAt || null)) {
    await db.update(schema.mintJobs).set({
      phaseStartsAt: phase.startsAt || null,
      phaseEndsAt: phase.endsAt || null,
      scheduledAt: phase.status === "upcoming" ? phase.startsAt || null : null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.mintJobs.id, job.id));
  }
  if (phase.status === "upcoming" && phase.startsAt) {
    if (job.dryRun) throw new MintNotOpenError(phase.startsAt);
    const requiresPayloadWarmup = adapter.requiresPayloadWarmup?.(collection, phase.id) === true;
    if (requiresPayloadWarmup) {
      if (!adapter.warmTransaction) throw new Error("Phase requires payload warming but its adapter does not implement it");
      const address = await signer.getAddress();
      try {
        await traceMintStage(job.id, "payload-acquisition", () => adapter.warmTransaction!(collection, address, job.quantity, provider, { phaseId: phase.id }));
      } catch (error) {
        recordMintSuppression(job.id, "payload-acquisition", `Provider did not permit early payload warming: ${safeErrorMessage(error)}`);
        // Competitive signed stages must never silently degrade to JIT work at
        // opening. A failed prearm is an explicit no-go while there is still
        // time for the operator to investigate or reschedule.
        throw new Error(`Signed mint could not be armed before launch: ${safeErrorMessage(error)}`);
      }
    }
    if (!adapter.supportsArming || (adapter.canArmPhase && !adapter.canArmPhase(phase.id))) throw new MintNotOpenError(phase.startsAt);
    return armMint(job, collection, phase);
  }
  const manualRetryAt = manualOpenRetryAt(phase);
  if (manualRetryAt) throw new MintNotOpenError(manualRetryAt, null);
  if (phase.status !== "live") throw new Error("The reviewed mint phase is not live");
  if (phase.endsAt && Date.now() >= Date.parse(phase.endsAt)) throw new Error("The reviewed mint phase has ended");
  if (phase.maxPerWallet && job.quantity > phase.maxPerWallet) throw new Error("Quantity exceeds the current on-chain wallet limit");

  const address = await signer.getAddress();
  if (!adapter?.buildTransaction) throw new Error("Mint adapter cannot build a reviewed transaction");

  const ladderResult = await executeOnePerTransactionLadder({ job, collection, wallet, phase, signer, provider });
  if (ladderResult) return ladderResult;

  let request = await traceMintStage(job.id, "payload-acquisition", () => adapter.buildTransaction!(collection, address, job.quantity, provider, jobAdapterOptions(job, phase.id)));
  void recordShadowMintIntent({ jobId: job.id, collection, walletAddress: address, quantity: job.quantity, phaseId: phase.id, provider, legacyRequest: request })
    .catch(() => undefined);
  const engine = executionEngineFor(collection);
  const fallbackGasLimit = reviewedFallbackGasLimit(collection.chainId, collection.adapterKey, job.quantity, adapter.recommendedGasLimit);
  request = await traceMintStage(job.id, "gas-preparation", () => applyGas(request, provider, address, job, fallbackGasLimit, engine.launchTimeGasEstimation));
  const approvalResult = await ensureErc20Approval(job, collection, phase, request, signer, provider);
  if (approvalResult) return approvalResult;
  await traceMintStage(job.id, "simulation", () => simulateExact(request, provider, address));

  if (job.dryRun) {
    await db.insert(schema.mintAttempts).values({
      id: randomUUID(),
      jobId: job.id,
      kind: "mint",
      status: "simulated",
      toAddress: String(request.to || ""),
      value: BigInt(request.value ?? 0).toString(),
      dataHash: stableHash(String(request.data || "0x")),
      gasLimit: request.gasLimit?.toString() || null,
      maxFeePerGas: request.maxFeePerGas?.toString() || request.gasPrice?.toString() || null,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas?.toString() || null,
      preparedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    });
    return { status: "simulation_passed", dryRun: true };
  }
  await assertBalanceAndSpendLimit(job.walletId, address, request, provider, { jobId: job.id, kind: "mint" });
  if (adapter.revalidateBeforeSigning) {
    await traceMintStage(job.id, "final-revalidation", () => adapter.revalidateBeforeSigning!(collection, address, job.quantity, provider, request, jobAdapterOptions(job, phase.id)));
  }
  return sendDurableAttempt({ job, kind: "mint", request, signer, provider });
}

export async function runMintJob(jobId: string): Promise<ExecutionResult | undefined> {
  const [initial] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
  if (!initial || initial.status === "cancelled" || initial.status === "completed" || initial.status === "failed") return;
  let attempt = initial.retryCount;

  while (attempt < initial.maxRetries) {
    try {
      const result = await executeMint(jobId);
      const now = new Date().toISOString();
      if (result.status === "armed") return result;
      if (result.status === "confirming") {
        await db.update(schema.mintJobs).set({ status: "confirming", updatedAt: now, error: null })
          .where(eq(schema.mintJobs.id, jobId));
        return result;
      }
      const completed = result.status === "confirmed" || result.status === "simulation_passed";
      await db.update(schema.mintJobs).set({
        status: completed ? "completed" : "failed",
        completedAt: now,
        updatedAt: now,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        error: result.error || null,
      }).where(eq(schema.mintJobs.id, jobId));
      return result;
    } catch (error) {
      const message = safeErrorMessage(error, "Mint execution failed");
      if (error instanceof MintNotOpenError) {
        await db.update(schema.mintJobs).set({
          status: "pending",
          scheduledAt: error.scheduledAt,
          phaseStartsAt: error.phaseStartsAt,
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
          error: null,
        }).where(eq(schema.mintJobs.id, jobId));
        return;
      }

      const safetyCode = mintErrorCode(error);
      if (safetyCode === MINT_ERROR_CODES.projectPaused || safetyCode === MINT_ERROR_CODES.phasePaused) {
        await db.update(schema.mintJobs).set({
          status: "pending",
          scheduledAt: new Date(Date.now() + 15_000).toISOString(),
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
          error: message,
        }).where(eq(schema.mintJobs.id, jobId));
        return;
      }

      const recoverable = await latestRecoverableAttempt(jobId, "mint") || await latestRecoverableAttempt(jobId, "approval");
      if (!liveTransactionsEnabled() && recoverable) {
        await db.update(schema.mintJobs).set({ status: "confirming", error: message, updatedAt: new Date().toISOString() })
          .where(eq(schema.mintJobs.id, jobId));
        return { status: "confirming", txHash: recoverable.txHash || undefined, error: message };
      }

      attempt += 1;
      const permanent = isPermanentMintError(message)
        || safetyCode === MINT_ERROR_CODES.definitionMismatch
        || safetyCode === MINT_ERROR_CODES.definitionUncertified;
      await db.update(schema.mintJobs).set({ retryCount: attempt, error: message, updatedAt: new Date().toISOString() })
        .where(eq(schema.mintJobs.id, jobId));
      if (permanent || attempt >= initial.maxRetries) {
        await db.update(schema.mintJobs).set({
          status: "failed",
          completedAt: new Date().toISOString(),
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
        }).where(eq(schema.mintJobs.id, jobId));
        await sendAlert("job_failed", `Mint job ${jobId.slice(0, 8)} failed: ${message}`, jobId);
        await createIncidentReplayBundle(jobId, permanent ? "permanent-execution-failure" : "retry-exhausted").catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)));
    }
  }
}

export async function batchMint(
  collectionId: string,
  walletIds: string[],
  quantity = 1,
  useFlashbots = false,
  dryRun = false,
  idempotencyBase: string,
  requestedPhases?: Array<{ walletId: string; phaseId: string }>,
) {
  if (!idempotencyBase || idempotencyBase.length > 200) throw new Error("A valid Idempotency-Key header is required");
  const uniqueRequests = requestedPhases?.length
    ? [...new Map(requestedPhases.map((item) => [`${item.walletId}:${item.phaseId}`, item])).values()]
    : undefined;
  const uniqueWalletIds = [...new Set(uniqueRequests?.map((item) => item.walletId) || walletIds)];
  const [collection] = await db.select().from(schema.collections).where(eq(schema.collections.id, collectionId)).limit(1);
  if (!collection || !collection.active || !collection.verified) throw new Error("Mint is not supported or is disabled");
  await assertMintControls(collection);
  const definitionPin = await scheduleMintDefinition(collection);
  if (quantity < 1) throw new Error("Mint quantity must be positive");
  const manifest = executionManifestFor(collection);
  const transactionsPerPlan = manifest.onePerTransaction ? quantity : 1;
  const transactionQuantity = manifest.onePerTransaction ? 1 : quantity;
  if (manifest.onePerTransaction && transactionsPerPlan > (manifest.maxPreparedTransactions || 1)) {
    throw new Error(`This mint supports at most ${manifest.maxPreparedTransactions || 1} sequential transactions per wallet`);
  }
  const wallets = uniqueWalletIds.length
    ? await db.select().from(schema.wallets).where(inArray(schema.wallets.id, uniqueWalletIds))
    : [];
  if (wallets.length !== uniqueWalletIds.length) throw new Error("One or more selected wallets were not found");
  if (manifest.onePerTransaction && transactionsPerPlan > 1 && wallets.some((wallet) => wallet.role !== "worker")) {
    throw new Error("Sequential nonce-ladder mode requires dedicated worker wallets; main wallets may schedule one transaction only");
  }
  const parentIds = [...new Set(wallets.flatMap((wallet) => wallet.role === "worker" && wallet.parentWalletId ? [wallet.parentWalletId] : []))];
  const parents = parentIds.length
    ? await db.select().from(schema.wallets).where(inArray(schema.wallets.id, parentIds))
    : [];
  const parentById = new Map(parents.map((parent) => [parent.id, parent]));
  for (const wallet of wallets) {
    const eligibilityError = mintWalletEligibilityError(
      wallet,
      collection.chainId,
      wallet.parentWalletId ? parentById.get(wallet.parentWalletId) : undefined,
    );
    if (eligibilityError) throw new Error(eligibilityError);
  }

  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter) throw new Error("The reviewed mint adapter is unavailable");
  const phases = (await adapter.resolve(collection, "name")).phases;
  const provider = getProvider(collection.chainId);
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const planRequests = uniqueRequests || uniqueWalletIds.map((walletId) => ({ walletId, phaseId: undefined }));
  const plans = await Promise.all(planRequests.map(async ({ walletId, phaseId }) => {
    const wallet = walletById.get(walletId)!;
    const signer = adapter.requiresSignerForEligibility ? await getSigner(wallet.id, provider) : undefined;
    const plan = phaseId
      ? await resolveWalletSelectedPhase(collection, wallet.address, transactionQuantity, phaseId, phases, { signer })
      : await resolveWalletPhasePlan(collection, wallet.address, transactionQuantity, phases, { signer });
    const phase = plan.selectedPhase;
    const eligibility = plan.eligibility.find((item) => item.phaseId === phase.id);
    if (!eligibility || eligibility.status !== "eligible") throw new Error(`${wallet.label} eligibility was not verified for ${phase.name}`);
    const scheduledAt = phase.status === "upcoming" ? phase.startsAt || manualOpenRetryAt(phase) : null;
    if (eligibility.artifactExpiresAt && scheduledAt && Date.parse(eligibility.artifactExpiresAt) <= Date.parse(scheduledAt)) {
      throw new Error(`${wallet.label} eligibility artifact expires before ${phase.name} opens`);
    }
    if (transactionQuantity > (phase.maxPerWallet || collection.maxPerWallet || 100)) {
      throw new Error(`${wallet.label} exceeds the ${phase.name} wallet limit`);
    }
    return {
      walletId,
      phase,
      eligibilityArtifactId: eligibility.artifactId || null,
      eligibilityArtifactHash: eligibility.artifactHash || null,
      scheduledAt,
    };
  }));
  await Promise.all([...new Set(plans.map((plan) => plan.phase.id))].map((phaseId) => assertMintControls(collection, phaseId)));
  const batchId = randomUUID();
  const values = plans.flatMap(({ walletId, phase, scheduledAt, eligibilityArtifactId, eligibilityArtifactHash }) => Array.from({ length: transactionsPerPlan }, (_, sequence) => ({
    id: randomUUID(), batchId, walletId, collectionId, quantity: transactionQuantity,
    ...definitionPin,
    useFlashbots, dryRun, scheduledAt, phaseId: phase.id,
    eligibilityArtifactId, eligibilityArtifactHash,
    phaseStartsAt: phase.startsAt || null, phaseEndsAt: phase.endsAt || null,
    status: "pending", idempotencyKey: `${idempotencyBase}:${walletId}:${collectionId}:${phase.id}:${sequence}`,
  })));
  const sharedSchedule = plans.every((plan) => plan.scheduledAt === plans[0]?.scheduledAt) ? plans[0]?.scheduledAt || null : null;
  const sharedPhaseId = plans.every((plan) => plan.phase.id === plans[0]?.phase.id) ? plans[0]?.phase.id || null : null;
  const waitingForOpen = plans.some((plan) => plan.phase.status === "upcoming" && plan.phase.manualOpen);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyBase}))`);
    const existing = await tx.select({
      id: schema.mintJobs.id,
      walletId: schema.mintJobs.walletId,
      batchId: schema.mintJobs.batchId,
    }).from(schema.mintJobs).where(inArray(schema.mintJobs.idempotencyKey, values.map((value) => value.idempotencyKey)));
    if (existing.length) {
      if (existing.length !== values.length) throw new Error("Idempotency key conflicts with a different wallet batch");
      return { batchId: existing[0]?.batchId || batchId, scheduledAt: sharedSchedule, phaseId: sharedPhaseId, waitingForOpen, results: existing.map((row) => ({ ...row, status: "duplicate" })) };
    }
    for (const walletId of [...uniqueWalletIds].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${walletId}`}))`);
    }
    const freshWallets = await tx.select().from(schema.wallets).where(inArray(schema.wallets.id, uniqueWalletIds));
    if (freshWallets.length !== uniqueWalletIds.length) throw new Error("One or more selected wallets were removed before scheduling");
    const freshParentIds = [...new Set(freshWallets.flatMap((wallet) => wallet.role === "worker" && wallet.parentWalletId ? [wallet.parentWalletId] : []))];
    const freshParents = freshParentIds.length
      ? await tx.select().from(schema.wallets).where(inArray(schema.wallets.id, freshParentIds))
      : [];
    const freshParentById = new Map(freshParents.map((parent) => [parent.id, parent]));
    for (const wallet of freshWallets) {
      const eligibilityError = mintWalletEligibilityError(
        wallet,
        collection.chainId,
        wallet.parentWalletId ? freshParentById.get(wallet.parentWalletId) : undefined,
      );
      if (eligibilityError) throw new Error(eligibilityError);
    }
    const inserted = await tx.insert(schema.mintJobs).values(values)
      .returning({ id: schema.mintJobs.id, walletId: schema.mintJobs.walletId, batchId: schema.mintJobs.batchId });
    const planByWalletPhase = new Map(plans.map((plan) => [`${plan.walletId}:${plan.phase.id}`, plan]));
    return {
      batchId,
      scheduledAt: sharedSchedule,
      phaseId: sharedPhaseId,
      waitingForOpen,
      results: inserted.map((row) => {
        const value = values.find((item) => item.id === row.id)!;
        const plan = planByWalletPhase.get(`${row.walletId}:${value.phaseId}`)!;
        return { ...row, phaseId: plan.phase.id, phaseName: plan.phase.name, scheduledAt: plan.scheduledAt, status: plan.scheduledAt ? "scheduled" : "queued" };
      }),
    };
  });
}

export async function recoverMintJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
  if (!job || !["running", "confirming"].includes(job.status)) return;
  const [attempt] = await db.select().from(schema.mintAttempts).where(eq(schema.mintAttempts.jobId, jobId))
    .orderBy(desc(schema.mintAttempts.createdAt)).limit(1);
  if (attempt?.rawTx) attempt.rawTx = openSignedTransaction(attempt.rawTx);
  if (attempt?.txHash) {
    const execution = await loadExecutionState(jobId);
    const provider = getProvider(execution.collection.chainId);
    const receipt = await traceMintStage(job.id, "receipt", () => provider.getTransactionReceipt(attempt.txHash!).catch(() => null), attempt.id);
    if (receipt) {
      const result = await finalizeAttempt(attempt.id, receipt);
      const recoveredStatus = recoveredJobStatus(attempt.kind === "approval" ? "approval" : "mint", result.status === "confirmed");
      if (recoveredStatus === "pending") {
        await db.update(schema.mintJobs).set({
          status: "pending",
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
          error: null,
        }).where(eq(schema.mintJobs.id, jobId));
        return;
      }
      await db.update(schema.mintJobs).set({
        status: recoveredStatus,
        completedAt: new Date().toISOString(),
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.mintJobs.id, jobId));
      return;
    }
    const observed = await provider.getTransaction(attempt.txHash).catch(() => null);
    const broadcastAge = attempt.broadcastAt ? Date.now() - Date.parse(attempt.broadcastAt) : Number.POSITIVE_INFINITY;
    if (observed || (["submitted", "confirming"].includes(attempt.status) && broadcastAge < 10_000)) {
      await db.update(schema.mintJobs).set({ status: "confirming", leaseExpiresAt: leaseExpiry(), updatedAt: new Date().toISOString() })
        .where(eq(schema.mintJobs.id, jobId));
      return;
    }
    if (attempt.rawTx && liveTransactionsEnabled()) {
      const outcome = await broadcastSameHash({
        attemptId: attempt.id,
        chainId: execution.collection.chainId,
        rawTx: attempt.rawTx,
        expectedHash: attempt.txHash,
      });
      await db.update(schema.mintAttempts).set({
        status: "confirming",
        broadcastAt: new Date().toISOString(),
        error: outcome.accepted ? null : "Rebroadcast acknowledgement remains ambiguous",
      }).where(eq(schema.mintAttempts.id, attempt.id));
      await db.update(schema.mintJobs).set({ status: "confirming", leaseExpiresAt: leaseExpiry(), updatedAt: new Date().toISOString() })
        .where(eq(schema.mintJobs.id, jobId));
      return;
    }
    await db.update(schema.mintJobs).set({ status: "confirming", leaseExpiresAt: leaseExpiry(), updatedAt: new Date().toISOString() })
      .where(eq(schema.mintJobs.id, jobId));
    return;
  }
  await db.update(schema.mintJobs).set({
    status: "pending",
    claimToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.mintJobs.id, jobId));
}

export function leaseExpiry(now = Date.now()): string {
  return new Date(now + JOB_LEASE_MS).toISOString();
}
