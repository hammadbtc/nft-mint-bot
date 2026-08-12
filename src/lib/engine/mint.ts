import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getMintAdapter } from "@/lib/adapters";
import type { MintPhase, SupportedCollection } from "@/lib/adapters/types";
import { recoveredJobStatus, selectExecutionPhase } from "@/lib/mint-policy";
import { getProvider } from "@/lib/chains";
import { sendPrivateTransaction, hasFlashbotsProtect } from "@/lib/chains/flashbots";
import { sendAlert } from "@/lib/alerting";
import { getSigner } from "@/lib/vault";
import {
  broadcastPreparedTransaction,
  exactSimulationRequest,
  prepareSignedTransaction,
  waitForReceipt,
} from "@/lib/transactions";
import {
  isPermanentMintError,
  liveTransactionsEnabled,
  requireLiveTransactions,
  safeErrorMessage,
  stableHash,
} from "@/lib/safety";

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const JOB_LEASE_MS = 120_000;

class MintNotOpenError extends Error {
  constructor(readonly scheduledAt: string) {
    super(`Mint is scheduled for ${scheduledAt}`);
  }
}

type JobRow = typeof schema.mintJobs.$inferSelect;
type AttemptRow = typeof schema.mintAttempts.$inferSelect;

type ExecutionResult = {
  status: "confirmed" | "failed" | "confirming" | "simulation_passed";
  txHash?: string;
  error?: string;
  dryRun?: boolean;
  gasUsed?: string;
  effectiveGasPrice?: string;
  blockNumber?: number;
};

async function resolvePhase(collection: SupportedCollection): Promise<MintPhase> {
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter) throw new Error("The reviewed mint adapter is unavailable");
  const resolved = await adapter.resolve(collection, "name");
  return selectExecutionPhase(resolved.phases);
}

async function loadExecutionState(jobId: string) {
  const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
  if (!job) throw new Error(`Mint job ${jobId} was not found`);
  const [[collection], [wallet]] = await Promise.all([
    db.select().from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1),
    db.select().from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1),
  ]);
  if (!collection || !collection.active || !collection.verified) throw new Error("Mint support is disabled or no longer verified");
  if (!wallet || !wallet.active || wallet.role !== "worker" || !wallet.parentWalletId) throw new Error("An active worker wallet is required");
  if (wallet.chainId !== collection.chainId) throw new Error("Worker wallet and mint network no longer match");
  return { job, collection, wallet };
}

async function applyGas(
  request: ethers.TransactionRequest,
  provider: ethers.Provider,
  from: string,
  overrides?: Pick<JobRow, "gasLimit" | "maxFeePerGas" | "maxPriorityFeePerGas">,
): Promise<ethers.TransactionRequest> {
  const exact = exactSimulationRequest(request, from);
  const [estimated, fees] = await Promise.all([
    provider.estimateGas(exact),
    provider.getFeeData(),
  ]);
  const gasLimit = overrides?.gasLimit ? BigInt(overrides.gasLimit) : (estimated * 120n) / 100n;
  const result: ethers.TransactionRequest = { ...request, gasLimit };
  if (overrides?.maxFeePerGas) result.maxFeePerGas = BigInt(overrides.maxFeePerGas);
  else if (fees.maxFeePerGas != null) result.maxFeePerGas = fees.maxFeePerGas;
  if (overrides?.maxPriorityFeePerGas) result.maxPriorityFeePerGas = BigInt(overrides.maxPriorityFeePerGas);
  else if (fees.maxPriorityFeePerGas != null) result.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  if (result.maxFeePerGas == null && fees.gasPrice != null) result.gasPrice = fees.gasPrice;
  return result;
}

async function simulateExact(request: ethers.TransactionRequest, provider: ethers.Provider, from: string): Promise<void> {
  try {
    await provider.call(exactSimulationRequest(request, from));
  } catch (error) {
    throw new Error(`Exact wallet simulation failed: ${safeErrorMessage(error, "transaction reverted")}`);
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
    where j.wallet_id = ${walletId}
      and a.status in ('prepared', 'submitted', 'confirming', 'confirmed')
      ${current ? sql`and not (a.job_id = ${current.jobId} and a.kind = ${current.kind})` : sql``}
  `);
  const [{ total = "0" } = {}] = rows as unknown as Array<{ total?: string }>;
  const reservedOrSpent = BigInt(total);
  if (reservedOrSpent + required > BigInt(wallet.spendLimit)) {
    throw new Error("Worker wallet spend limit would be exceeded");
  }
}

async function latestRecoverableAttempt(jobId: string, kind: "approval" | "mint"): Promise<AttemptRow | undefined> {
  const [attempt] = await db.select().from(schema.mintAttempts)
    .where(and(eq(schema.mintAttempts.jobId, jobId), eq(schema.mintAttempts.kind, kind)))
    .orderBy(desc(schema.mintAttempts.createdAt)).limit(1);
  return attempt && attempt.txHash && attempt.rawTx && ["prepared", "submitted", "confirming"].includes(attempt.status)
    ? attempt
    : undefined;
}

async function sendDurableAttempt(args: {
  job: JobRow;
  kind: "approval" | "mint";
  request: ethers.TransactionRequest;
  signer: ethers.Signer;
  provider: ethers.Provider;
}): Promise<ExecutionResult> {
  const { job, kind, request, signer, provider } = args;
  let attempt = await latestRecoverableAttempt(job.id, kind);

  if (!attempt) {
    const attemptId = randomUUID();
    const prepared = await prepareSignedTransaction(
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
          rawTx: signed.rawTx,
          toAddress: String(signed.request.to || ""),
          value: BigInt(signed.request.value ?? 0).toString(),
          dataHash: stableHash(String(signed.request.data || "0x")),
          gasLimit: signed.request.gasLimit?.toString() || null,
          maxFeePerGas: signed.request.maxFeePerGas?.toString() || signed.request.gasPrice?.toString() || null,
          maxPriorityFeePerGas: signed.request.maxPriorityFeePerGas?.toString() || null,
          preparedAt: new Date().toISOString(),
        });
      },
    );
    [attempt] = await db.select().from(schema.mintAttempts).where(eq(schema.mintAttempts.id, attemptId)).limit(1);
    if (!attempt) throw new Error("Prepared transaction was not durably recorded");
    if (attempt.txHash?.toLowerCase() !== prepared.txHash.toLowerCase()) throw new Error("Prepared transaction hash mismatch");
  }

  const receiptBeforeBroadcast = await provider.getTransactionReceipt(attempt.txHash!).catch(() => null);
  if (receiptBeforeBroadcast) return finalizeAttempt(attempt.id, receiptBeforeBroadcast);

  requireLiveTransactions();
  try {
    if (job.useFlashbots && hasFlashbotsProtect(Number(request.chainId))) {
      const response = await sendPrivateTransaction(Number(request.chainId), attempt.rawTx!);
      if (response.hash.toLowerCase() !== attempt.txHash!.toLowerCase()) throw new Error("Private relay returned an unexpected hash");
    } else {
      await broadcastPreparedTransaction(provider, attempt.rawTx!, attempt.txHash!);
    }
    await db.update(schema.mintAttempts).set({ status: "submitted", broadcastAt: new Date().toISOString(), error: null })
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

  const receipt = await waitForReceipt(provider, attempt.txHash!);
  if (!receipt) {
    await db.update(schema.mintAttempts).set({ status: "confirming" }).where(eq(schema.mintAttempts.id, attempt.id));
    return { status: "confirming", txHash: attempt.txHash! };
  }
  return finalizeAttempt(attempt.id, receipt);
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
  request: ethers.TransactionRequest,
  signer: ethers.Signer,
  provider: ethers.Provider,
): Promise<ExecutionResult | null> {
  if (!collection.paymentToken) return null;
  const owner = await signer.getAddress();
  const spender = String(request.to || collection.contractAddress);
  const needed = BigInt(collection.mintPrice || "0") * BigInt(job.quantity);
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

export async function executeMint(jobId: string): Promise<ExecutionResult> {
  const { job, collection } = await loadExecutionState(jobId);
  const phase = await resolvePhase(collection);
  if (phase.status === "upcoming" && phase.startsAt) throw new MintNotOpenError(phase.startsAt);
  if (phase.status !== "live") throw new Error("The reviewed mint phase is not live");
  if (phase.endsAt && Date.now() >= Date.parse(phase.endsAt)) throw new Error("The reviewed mint phase has ended");
  if (phase.maxPerWallet && job.quantity > phase.maxPerWallet) throw new Error("Quantity exceeds the current on-chain wallet limit");

  const provider = getProvider(collection.chainId);
  const signer = await getSigner(job.walletId, provider);
  const address = await signer.getAddress();
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter?.buildTransaction) throw new Error("Mint adapter cannot build a reviewed transaction");

  let request = await adapter.buildTransaction(collection, address, job.quantity, provider);
  request = await applyGas(request, provider, address, job);
  const approvalResult = await ensureErc20Approval(job, collection, request, signer, provider);
  if (approvalResult) return approvalResult;
  await simulateExact(request, provider, address);

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
          phaseStartsAt: error.scheduledAt,
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
          error: null,
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
      const permanent = isPermanentMintError(message);
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
) {
  if (!idempotencyBase || idempotencyBase.length > 200) throw new Error("A valid Idempotency-Key header is required");
  const uniqueWalletIds = [...new Set(walletIds)];
  const [collection] = await db.select().from(schema.collections).where(eq(schema.collections.id, collectionId)).limit(1);
  if (!collection || !collection.active || !collection.verified) throw new Error("Mint is not supported or is disabled");
  const phase = await resolvePhase(collection);
  if (phase.status === "ended") throw new Error("The reviewed mint has ended");
  if (quantity < 1 || quantity > (phase.maxPerWallet || collection.maxPerWallet || 100)) {
    throw new Error("Quantity exceeds the current supported wallet limit");
  }

  const wallets = uniqueWalletIds.length
    ? await db.select().from(schema.wallets).where(inArray(schema.wallets.id, uniqueWalletIds))
    : [];
  if (wallets.length !== uniqueWalletIds.length) throw new Error("One or more selected wallets were not found");
  for (const wallet of wallets) {
    if (!wallet.active || wallet.role !== "worker" || !wallet.parentWalletId) throw new Error("Only active worker wallets can mint");
    if (wallet.chainId !== collection.chainId) throw new Error("One or more workers are on the wrong network");
  }

  const scheduledAt = phase.status === "upcoming" ? phase.startsAt : undefined;
  const batchId = randomUUID();
  const values = uniqueWalletIds.map((walletId) => ({
    id: randomUUID(),
    batchId,
    walletId,
    collectionId,
    quantity,
    useFlashbots,
    dryRun,
    scheduledAt: scheduledAt || null,
    phaseId: phase.id,
    phaseStartsAt: phase.startsAt || null,
    phaseEndsAt: phase.endsAt || null,
    status: "pending",
    idempotencyKey: `${idempotencyBase}:${walletId}:${collectionId}`,
  }));

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyBase}))`);
    const existing = await tx.select({
      id: schema.mintJobs.id,
      walletId: schema.mintJobs.walletId,
      batchId: schema.mintJobs.batchId,
    }).from(schema.mintJobs).where(inArray(schema.mintJobs.idempotencyKey, values.map((value) => value.idempotencyKey)));
    if (existing.length) {
      if (existing.length !== values.length) throw new Error("Idempotency key conflicts with a different wallet batch");
      return { batchId: existing[0]?.batchId || batchId, scheduledAt: scheduledAt || null, phaseId: phase.id, results: existing.map((row) => ({ ...row, status: "duplicate" })) };
    }
    const inserted = await tx.insert(schema.mintJobs).values(values)
      .returning({ id: schema.mintJobs.id, walletId: schema.mintJobs.walletId, batchId: schema.mintJobs.batchId });
    return { batchId, scheduledAt: scheduledAt || null, phaseId: phase.id, results: inserted.map((row) => ({ ...row, status: scheduledAt ? "scheduled" : "queued" })) };
  });
}

export async function recoverMintJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
  if (!job || !["running", "confirming"].includes(job.status)) return;
  const [attempt] = await db.select().from(schema.mintAttempts).where(eq(schema.mintAttempts.jobId, jobId))
    .orderBy(desc(schema.mintAttempts.createdAt)).limit(1);
  if (attempt?.txHash) {
    const provider = getProvider((await loadExecutionState(jobId)).collection.chainId);
    const receipt = await provider.getTransactionReceipt(attempt.txHash).catch(() => null);
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
    if (attempt.rawTx && liveTransactionsEnabled()) {
      await runMintJob(jobId);
      return;
    }
    await db.update(schema.mintJobs).set({ status: "confirming", updatedAt: new Date().toISOString() })
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
