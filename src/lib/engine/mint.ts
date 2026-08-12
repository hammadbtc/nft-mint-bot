import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { db, schema } from "@/lib/db";
import { getSigner } from "@/lib/vault";
import { getProvider } from "@/lib/chains";
import { sendPrivateTransaction, hasFlashbotsProtect } from "@/lib/chains/flashbots";
import { sendAlert } from "@/lib/alerting";
import { eq, and, desc, sql } from "drizzle-orm";
import { getMintAdapter } from "@/lib/adapters";

// ─── ERC20 Minimal ABI ────────────────────────────────────────────────
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    if (typeof value.reason === "string") return value.reason;
    if (typeof value.message === "string") return value.message;
  }
  return String(error);
}

class AmbiguousBroadcastError extends Error {}

// ─── Nonce Manager (in-process) ────────────────────────────────────────
const nonceLock = new Map<string, Promise<void>>();
const nonceCache = new Map<string, number>(); // walletId -> next nonce

async function acquireNonce(
  walletId: string,
  address: string,
  provider: ethers.Provider
): Promise<number> {
  while (nonceLock.has(walletId)) {
    await nonceLock.get(walletId);
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  nonceLock.set(walletId, lock);

  try {
    const onChainNonce = await provider.getTransactionCount(address, "pending");
    const cachedNonce = nonceCache.get(walletId) ?? onChainNonce;
    const nonce = Math.max(onChainNonce, cachedNonce);
    nonceCache.set(walletId, nonce + 1);
    return nonce;
  } finally {
    nonceLock.delete(walletId);
    resolve!();
  }
}

function releaseNonce(walletId: string) {
  nonceLock.delete(walletId);
}

/** Roll back the cached nonce after a pre-broadcast failure. */
function rollbackNonce(walletId: string) {
  const cached = nonceCache.get(walletId);
  if (cached !== undefined && cached > 0) {
    nonceCache.set(walletId, cached - 1);
  }
  nonceLock.delete(walletId);
}

// ─── Gas Estimation ────────────────────────────────────────────────────

interface GasConfig {
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

async function estimateGas(
  tx: ethers.TransactionRequest,
  provider: ethers.Provider
): Promise<GasConfig> {
  try {
    const feeData = await provider.getFeeData();
    const gasLimit = await provider.estimateGas(tx).catch(() => 300_000n);
    const bufferedLimit = (gasLimit * 120n) / 100n;

    return {
      gasLimit: bufferedLimit,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    };
  } catch (err) {
    console.warn("Gas estimation failed, using defaults:", err);
    return { gasLimit: 500_000n };
  }
}

// ─── Simulation ────────────────────────────────────────────────────────

async function simulateTx(
  tx: ethers.TransactionRequest,
  provider: ethers.Provider
): Promise<{ success: boolean; error?: string }> {
  try {
    await provider.call({
      ...tx,
      gasLimit: tx.gasLimit || 1_000_000n,
    });
    return { success: true };
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn("Simulation failed:", message);
    return { success: false, error: message };
  }
}

// ─── Cancel Stuck Transaction ──────────────────────────────────────────

/**
 * Cancel a stuck transaction by sending 0 ETH to self with the same nonce
 * but much higher gas. This replaces the pending tx in the mempool.
 */
export async function cancelStuckTransaction(
  walletId: string,
  chainId: number,
  nonce: number
): Promise<{ txHash: string }> {
  const provider = getProvider(chainId);
  const signer = await getSigner(walletId, provider);
  const feeData = await provider.getFeeData();

  const cancelTx: ethers.TransactionRequest = {
    to: signer.address, // send to self
    value: 0n,
    nonce,
    chainId,
    gasLimit: 21000n,
    // 2x the current max fee to ensure replacement
    maxFeePerGas: (feeData.maxFeePerGas ?? 50_000_000_000n) * 2n,
    maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 2_000_000_000n) * 2n,
  };

  const tx = await signer.sendTransaction(cancelTx);
  return { txHash: tx.hash };
}

/**
 * Speed up a stuck transaction by re-sending with higher gas.
 */
export async function speedUpTransaction(
  walletId: string,
  chainId: number,
  nonce: number,
  originalTx: ethers.TransactionRequest
): Promise<{ txHash: string }> {
  const provider = getProvider(chainId);
  const signer = await getSigner(walletId, provider);
  const feeData = await provider.getFeeData();

  const baseMaxFee = feeData.maxFeePerGas ?? (originalTx.maxFeePerGas as bigint | null) ?? 50_000_000_000n;
  const baseMaxPriority = feeData.maxPriorityFeePerGas ?? (originalTx.maxPriorityFeePerGas as bigint | null) ?? 2_000_000_000n;

  const speedUpTx: ethers.TransactionRequest = {
    ...originalTx,
    nonce,
    maxFeePerGas: baseMaxFee * 15n / 10n,
    maxPriorityFeePerGas: baseMaxPriority * 15n / 10n,
  };

  const tx = await signer.sendTransaction(speedUpTx);
  return { txHash: tx.hash };
}

// ─── Mint Job Execution ────────────────────────────────────────────────

export interface MintJobParams {
  walletId: string;
  collectionId: string;
  quantity?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  useFlashbots?: boolean;
  dryRun?: boolean;
  attemptId?: string;
  jobId?: string;
}

/**
 * Execute a single mint attempt. If dryRun is true, simulates only and returns.
 */
export async function executeMint(params: MintJobParams) {
  const { walletId, collectionId, dryRun } = params;

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);

  if (!collection) throw new Error(`Collection ${collectionId} not found`);

  const provider = getProvider(collection.chainId);
  const signer = await getSigner(walletId, provider);

  const adapter = getMintAdapter(collection.adapterKey);
  let tx: ethers.TransactionRequest;
  if (adapter?.buildTransaction) {
    tx = await adapter.buildTransaction(collection, signer.address, params.quantity || 1, provider);
  } else {
    let mintAbi: ethers.InterfaceAbi;
    try { mintAbi = JSON.parse(collection.mintAbi); }
    catch { throw new Error(`Invalid ABI for collection ${collection.name}`); }
    const contract = new ethers.Contract(collection.contractAddress, mintAbi, signer);
    const mintFn = contract.getFunction(collection.mintMethod);
    let txData: string;
    try { txData = (await mintFn.populateTransaction(params.quantity || 1)).data!; }
    catch { txData = (await mintFn.populateTransaction()).data!; }
    tx = { to: collection.contractAddress, data: txData, chainId: collection.chainId };
    if (collection.mintPrice) tx.value = BigInt(collection.mintPrice) * BigInt(params.quantity || 1);
  }

  // ─── Gas Estimation (must run before balance/spend checks) ──────────
  const gas = await estimateGas(tx, provider);
  if (params.gasLimit) tx.gasLimit = BigInt(params.gasLimit);
  else if (gas.gasLimit) tx.gasLimit = gas.gasLimit;

  if (params.maxFeePerGas) tx.maxFeePerGas = BigInt(params.maxFeePerGas);
  else if (gas.maxFeePerGas) tx.maxFeePerGas = gas.maxFeePerGas;

  if (params.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = BigInt(params.maxPriorityFeePerGas);
  else if (gas.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = gas.maxPriorityFeePerGas;

  // ─── Balance Check (uses real estimated gas) ─────────────────────
  if (!dryRun) {
    const ethBalance = await provider.getBalance(signer.address);
    const glB: bigint = (tx.gasLimit ?? 500_000n) as bigint;
    const mfpB: bigint = (tx.maxFeePerGas ?? 50_000_000_000n) as bigint;
    const estGasCost = glB * mfpB;
    const txVal: bigint = BigInt(tx.value ?? 0);
    const totalNeeded = txVal + estGasCost;

    if (ethBalance < totalNeeded) {
      throw new Error(
        `Insufficient ETH balance: have ${ethers.formatEther(ethBalance)} ETH, ` +
        `need ~${ethers.formatEther(totalNeeded)} ETH (value + gas)`
      );
    }

    // ERC20 token balance if payment token is set
    if (collection.paymentToken) {
      const token = new ethers.Contract(collection.paymentToken, ERC20_ABI, provider);
      const tokenBalance = BigInt(await token.getFunction("balanceOf").staticCall(signer.address));
      const tokenDecimals = Number(await token.getFunction("decimals").staticCall().catch(() => 18));
      const tokenNeeded = BigInt(collection.mintPrice || "0") * BigInt(params.quantity || 1);

      if (tokenBalance < tokenNeeded) {
        throw new Error(
          `Insufficient token balance: have ${ethers.formatUnits(tokenBalance, tokenDecimals)}, ` +
          `need ${ethers.formatUnits(tokenNeeded, tokenDecimals)}`
        );
      }

      // Check allowance and approve if needed
      const allowance = BigInt(await token.getFunction("allowance").staticCall(signer.address, collection.contractAddress));
      if (allowance < tokenNeeded) {
        console.log(`🔓 Approving ${ethers.formatUnits(tokenNeeded, tokenDecimals)} tokens for ${collection.name}...`);
        try {
          const approveTx = await token.connect(signer).getFunction("approve").send(collection.contractAddress, tokenNeeded);
          await approveTx.wait(1);
          console.log(`✅ Approval confirmed: ${approveTx.hash}`);
        } catch (err: unknown) {
          throw new Error(`Token approval failed: ${errorMessage(err)}`);
        }
      }
    }
  }

  // Reserve the mint nonce only after any ERC-20 approval transaction has confirmed.
  const nonce = await acquireNonce(walletId, signer.address, provider);
  tx.nonce = nonce;

  // ─── Spend limit check (uses estimated gas from above) ─────────────
  if (!dryRun) {
    const [wallet] = await db
      .select({ spendLimit: schema.wallets.spendLimit })
      .from(schema.wallets)
      .where(eq(schema.wallets.id, walletId))
      .limit(1);

    if (wallet?.spendLimit) {
      const spendLimit = BigInt(wallet.spendLimit);
      const txValueS: bigint = BigInt(tx.value ?? 0);
      const glS: bigint = (tx.gasLimit ?? 500_000n) as bigint;
      const mfpS: bigint = (tx.maxFeePerGas ?? 50_000_000_000n) as bigint;
      const estimatedGasCost = glS * mfpS;
      const totalCost = txValueS + estimatedGasCost;

      // Calculate total already spent
      const [spent] = await db
        .select({
          total: sql<number>`coalesce(sum(cast(${schema.mintAttempts.gasUsed} as integer) * cast(${schema.mintAttempts.effectiveGasPrice} as integer)), 0)`,
        })
        .from(schema.mintAttempts)
        .innerJoin(schema.mintJobs, eq(schema.mintAttempts.jobId, schema.mintJobs.id))
        .where(
          and(
            eq(schema.mintJobs.walletId, walletId),
            eq(schema.mintAttempts.status, "submitted")
          )
        );

      const previousSpend = BigInt(spent?.total || 0);

      if (previousSpend + totalCost > spendLimit) {
        rollbackNonce(walletId);
        throw new Error(
          `Spend limit exceeded: already spent ${ethers.formatEther(previousSpend)} ETH, ` +
          `this tx would cost ~${ethers.formatEther(totalCost)} ETH, ` +
          `limit is ${ethers.formatEther(spendLimit)} ETH`
        );
      }
    }
  }

  // Simulate
  const sim = await simulateTx(tx, provider);
  if (!sim.success) {
    rollbackNonce(walletId);
    return {
      status: "simulation_failed",
      error: sim.error,
      dryRun: dryRun ?? false,
    };
  }

  // Dry run: stop after simulation
  if (dryRun) {
    rollbackNonce(walletId);
    return {
      status: "simulation_passed",
      dryRun: true,
      simulation: {
        to: tx.to,
        value: tx.value?.toString(),
        gasLimit: tx.gasLimit?.toString(),
        maxFeePerGas: tx.maxFeePerGas?.toString(),
        nonce,
        chainId: tx.chainId,
      },
    };
  }

  if (process.env.ENABLE_LIVE_TRANSACTIONS !== "true") {
    rollbackNonce(walletId);
    throw new Error("Live mint transactions are disabled until testnet verification is complete");
  }

  // ─── Send Transaction ──────────────────────────────────────────────
  let response: ethers.TransactionResponse;
  let sentVia = "public";

  try {
    if (params.useFlashbots && hasFlashbotsProtect(collection.chainId)) {
      // Use Flashbots Protect RPC for private mempool
      const signed = await signer.signTransaction(tx);
      response = await sendPrivateTransaction(collection.chainId, signed);
      sentVia = "flashbots_protect";
    } else {
      response = await signer.sendTransaction(tx);
    }
  } catch (err: unknown) {
    // Don't rollback — tx may have been broadcast. But release the lock.
    releaseNonce(walletId);
    throw new AmbiguousBroadcastError(`Broadcast outcome is unknown and will not be retried automatically: ${errorMessage(err)}`);
  }

  // Persist the hash before waiting. A receipt timeout must never cause a duplicate mint.
  if (params.attemptId && params.jobId) {
    await db.insert(schema.mintAttempts).values({
      id: params.attemptId,
      jobId: params.jobId,
      txHash: response.hash,
      status: "submitted",
    }).onConflictDoUpdate({
      target: schema.mintAttempts.id,
      set: { txHash: response.hash, status: "submitted" },
    });
  }

  // Wait for confirmation
  const receipt = await response.wait(1);

  if (params.attemptId) {
    await db.update(schema.mintAttempts).set({
      status: receipt?.status === 1 ? "confirmed" : "failed",
      gasUsed: receipt?.gasUsed?.toString(),
      effectiveGasPrice: receipt?.gasPrice?.toString(),
      blockNumber: receipt?.blockNumber,
    }).where(eq(schema.mintAttempts.id, params.attemptId));
  }

  return {
    txHash: response.hash,
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed?.toString(),
    effectiveGasPrice: receipt?.gasPrice?.toString(),
    status: receipt?.status === 1 ? "confirmed" : "failed",
    sentVia,
  };
}

// ─── Job Runner ────────────────────────────────────────────────────────

export async function runMintJob(jobId: string) {
  const [job] = await db
    .select()
    .from(schema.mintJobs)
    .where(eq(schema.mintJobs.id, jobId))
    .limit(1);

  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status === "cancelled") return;

  // Only mark as running if not already (multi-worker safety)
  if (job.status !== "running") {
    await db
      .update(schema.mintJobs)
      .set({ status: "running", startedAt: new Date().toISOString() })
      .where(eq(schema.mintJobs.id, jobId));
  }

  let lastAttempt = job.retryCount;

  while (lastAttempt < job.maxRetries) {
    const attemptId = uuidv4();

    try {
      const result = await executeMint({
        walletId: job.walletId,
        collectionId: job.collectionId,
        quantity: job.quantity || 1,
        gasLimit: job.gasLimit || undefined,
        maxFeePerGas: job.maxFeePerGas || undefined,
        maxPriorityFeePerGas: job.maxPriorityFeePerGas || undefined,
        useFlashbots: job.useFlashbots ?? false,
        dryRun: job.dryRun ?? false,
        attemptId,
        jobId,
      });

      // Dry run result
      if (result.dryRun) {
        await db.insert(schema.mintAttempts).values({
          id: attemptId,
          jobId,
          status: result.status === "simulation_passed" ? "confirmed" : "failed",
          error: result.error || null,
        });

        await db
          .update(schema.mintJobs)
          .set({
            status: result.status === "simulation_passed" ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            error: result.error || null,
          })
          .where(eq(schema.mintJobs.id, jobId));
        return result;
      }

      const finalStatus = result.status === "confirmed" ? "completed" : "failed";

      await db
        .update(schema.mintJobs)
        .set({
          status: finalStatus,
          completedAt: new Date().toISOString(),
          nonce: null,
          claimToken: null,
          claimedAt: null,
        })
        .where(eq(schema.mintJobs.id, jobId));

      // Alert on failure
      if (finalStatus === "failed") {
        const [wallet] = await db.select({ label: schema.wallets.label }).from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1);
        const [collection] = await db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1);
        await sendAlert("job_failed", `Job ${jobId.slice(0, 8)} failed: ${wallet?.label || "?"} → ${collection?.name || "?"}`, jobId);
      }

      return result;
    } catch (err: unknown) {
      const [broadcast] = await db.select({ txHash:schema.mintAttempts.txHash })
        .from(schema.mintAttempts).where(eq(schema.mintAttempts.id, attemptId)).limit(1);
      if (broadcast?.txHash) {
        const message = `Broadcast as ${broadcast.txHash}; confirmation is unknown and will not be retried automatically: ${errorMessage(err)}`;
        await db.update(schema.mintJobs).set({ status:"failed", completedAt:new Date().toISOString(), error:message })
          .where(eq(schema.mintJobs.id, jobId));
        await db.update(schema.mintAttempts).set({ error:message }).where(eq(schema.mintAttempts.id, attemptId));
        throw new Error(message);
      }
      if (err instanceof AmbiguousBroadcastError) {
        const message = err.message;
        await db.insert(schema.mintAttempts).values({ id:attemptId, jobId, status:"failed", error:message }).onConflictDoNothing();
        await db.update(schema.mintJobs).set({ status:"failed", completedAt:new Date().toISOString(), error:message, claimToken:null, claimedAt:null })
          .where(eq(schema.mintJobs.id, jobId));
        throw err;
      }
      lastAttempt++;

      await db.insert(schema.mintAttempts).values({
        id: attemptId,
        jobId,
        status: "failed",
        error: errorMessage(err),
      });

      await db
        .update(schema.mintJobs)
        .set({ retryCount: lastAttempt, error: errorMessage(err) })
        .where(eq(schema.mintJobs.id, jobId));

      if (lastAttempt >= job.maxRetries) {
        await db
          .update(schema.mintJobs)
          .set({ status: "failed", completedAt: new Date().toISOString(), claimToken:null, claimedAt:null })
          .where(eq(schema.mintJobs.id, jobId));

        // Alert on final failure
        const [wallet] = await db.select({ label: schema.wallets.label }).from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1);
        const [collection] = await db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1);
        await sendAlert("job_failed", `Job ${jobId.slice(0, 8)} exhausted retries: ${wallet?.label || "?"} → ${collection?.name || "?"} — ${errorMessage(err)}`, jobId);

        throw err;
      }

      // Exponential backoff
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, lastAttempt)));
    }
  }
}

/**
 * Mark a job as "stuck" and cancel its pending tx.
 */
export async function unstickJob(jobId: string) {
  const [job] = await db
    .select()
    .from(schema.mintJobs)
    .where(eq(schema.mintJobs.id, jobId))
    .limit(1);

  if (!job) throw new Error(`Job ${jobId} not found`);

  // Find the wallet and chain
  const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1);
  if (!wallet) throw new Error("Wallet not found");

  // Stuck jobs need a cancel tx
  try {
    // Get the nonce that was used (from last attempt or estimate)
    const attempts = await db
      .select()
      .from(schema.mintAttempts)
      .where(eq(schema.mintAttempts.jobId, jobId))
      .orderBy(desc(schema.mintAttempts.createdAt))
      .limit(1);

    if (attempts.length > 0) {
      // Can't easily recover the nonce from a failed attempt, so we'll cancel using
      // the wallet's current pending nonce
      const provider = getProvider(wallet.chainId);
      const signer = await getSigner(job.walletId, provider);
      const pendingNonce = await provider.getTransactionCount(signer.address, "pending");
      const latestNonce = await provider.getTransactionCount(signer.address, "latest");

      if (pendingNonce > latestNonce) {
        // There's a stuck pending tx — cancel it
        const { txHash } = await cancelStuckTransaction(job.walletId, wallet.chainId, latestNonce);
        console.log(`🔧 Unstuck job ${jobId.slice(0, 8)}: sent cancel tx ${txHash}`);
      }
    }

    await db
      .update(schema.mintJobs)
      .set({ status: "cancelled", completedAt: new Date().toISOString(), error: "unstuck by operator" })
      .where(eq(schema.mintJobs.id, jobId));

    await sendAlert("job_stuck", `Job ${jobId.slice(0, 8)} unstuck and cancelled`, jobId);
    return { success: true };
  } catch (err: unknown) {
    throw new Error(`Failed to unstick job: ${errorMessage(err)}`);
  }
}

/**
 * Batch mint: create jobs for all wallets against a collection and execute.
 */
export async function batchMint(
  collectionId: string,
  walletIds: string[],
  quantity?: number,
  useFlashbots?: boolean,
  dryRun?: boolean,
  scheduledAt?: string,
  idempotencyBase?: string,
) {
  const results: { walletId: string; jobId: string; status: string; txHash?: string; error?: string }[] = [];

  const [collection] = await db.select().from(schema.collections).where(eq(schema.collections.id, collectionId)).limit(1);
  if (!collection || !collection.active || !collection.verified) throw new Error("Mint is not supported or is disabled");
  const mintQuantity = quantity || 1;
  if (mintQuantity < 1 || mintQuantity > (collection.maxPerWallet || 100)) throw new Error("Quantity exceeds the supported wallet limit");

  for (const walletId of walletIds) {
    const [wallet] = await db.select({ id:schema.wallets.id, chainId:schema.wallets.chainId, active:schema.wallets.active })
      .from(schema.wallets).where(eq(schema.wallets.id, walletId)).limit(1);
    if (!wallet || !wallet.active) throw new Error(`Wallet ${walletId} is unavailable`);
    if (wallet.chainId !== collection.chainId) throw new Error(`Wallet ${walletId} is on the wrong network`);
    const jobId = uuidv4();
    const idempotencyKey = idempotencyBase ? `${idempotencyBase}:${walletId}:${collectionId}` : null;

    const inserted = await db.insert(schema.mintJobs).values({
      id: jobId,
      walletId,
      collectionId,
      quantity: quantity || 1,
      useFlashbots: useFlashbots ?? false,
      dryRun: dryRun ?? false,
      scheduledAt: scheduledAt || null,
      status: "pending",
      idempotencyKey,
    }).onConflictDoNothing({ target:schema.mintJobs.idempotencyKey }).returning({ id:schema.mintJobs.id });
    let resultJobId = inserted[0]?.id;
    if (!resultJobId && idempotencyKey) {
      const [existing] = await db.select({ id:schema.mintJobs.id }).from(schema.mintJobs)
        .where(eq(schema.mintJobs.idempotencyKey,idempotencyKey)).limit(1);
      resultJobId = existing?.id;
    }
    results.push({ walletId, jobId:resultJobId || jobId, status:inserted.length ? (scheduledAt?"scheduled":"queued") : "duplicate" });
  }

  return results;
}
