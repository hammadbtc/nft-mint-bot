import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { db, schema } from "@/lib/db";
import { getSigner } from "@/lib/vault";
import { getProvider, getChain } from "@/lib/chains";
import { sendPrivateTransaction, sendFlashbotsBundle, hasFlashbotsProtect } from "@/lib/chains/flashbots";
import { sendAlert } from "@/lib/alerting";
import { checkContractSafety } from "@/lib/engine/safety";
import { eq, and, desc, sql } from "drizzle-orm";

// ─── ERC20 Minimal ABI ────────────────────────────────────────────────
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

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
  } catch (err: any) {
    const message = err?.revert?.args?.[0] ?? err?.reason ?? err?.message ?? String(err);
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

  const chain = getChain(collection.chainId);
  const provider = getProvider(collection.chainId);
  const signer = await getSigner(walletId, provider);

  let mintAbi: any;
  try {
    mintAbi = JSON.parse(collection.mintAbi);
  } catch {
    throw new Error(`Invalid ABI for collection ${collection.name}`);
  }

  const contract = new ethers.Contract(collection.contractAddress, mintAbi, signer);
  const mintFn = contract.getFunction(collection.mintMethod);
  let txData: string;

  try {
    const populated = await mintFn.populateTransaction(params.quantity || 1);
    txData = populated.data!;
  } catch {
    const populated = await mintFn.populateTransaction();
    txData = populated.data!;
  }

  const nonce = await acquireNonce(walletId, signer.address, provider);

  const tx: ethers.TransactionRequest = {
    to: collection.contractAddress,
    data: txData,
    nonce,
    chainId: collection.chainId,
  };

  if (collection.mintPrice) {
    tx.value = BigInt(collection.mintPrice) * BigInt(params.quantity || 1);
  }

  // ─── Balance Check ───────────────────────────────────────────────
  if (!dryRun) {
    // ETH balance
    const ethBalance = await provider.getBalance(signer.address);
    const glEst: bigint = (tx.gasLimit ?? 500_000n) as bigint;
    const mfpEst: bigint = (tx.maxFeePerGas ?? 50_000_000_000n) as bigint;
    const estGasCost = glEst * mfpEst;
    const txVal: bigint = BigInt(tx.value ?? 0);
    const totalNeeded = txVal + estGasCost;

    if (ethBalance < totalNeeded) {
      releaseNonce(walletId);
      throw new Error(
        `Insufficient ETH balance: have ${ethers.formatEther(ethBalance)} ETH, ` +
        `need ~${ethers.formatEther(totalNeeded)} ETH (value + gas)`
      );
    }

    // ERC20 token balance if payment token is set
    if (collection.paymentToken) {
      const token = new ethers.Contract(collection.paymentToken, ERC20_ABI, provider);
      const tokenBalance: bigint = await (token as any).balanceOf(signer.address);
      const tokenDecimals: number = await (token as any).decimals().catch(() => 18);
      const tokenNeeded = BigInt(collection.mintPrice || "0") * BigInt(params.quantity || 1);

      if (tokenBalance < tokenNeeded) {
        releaseNonce(walletId);
        throw new Error(
          `Insufficient token balance: have ${ethers.formatUnits(tokenBalance, tokenDecimals)}, ` +
          `need ${ethers.formatUnits(tokenNeeded, tokenDecimals)}`
        );
      }

      // Check allowance and approve if needed
      const allowance: bigint = await (token as any).allowance(signer.address, collection.contractAddress);
      if (allowance < tokenNeeded) {
        console.log(`🔓 Approving ${ethers.formatUnits(tokenNeeded, tokenDecimals)} tokens for ${collection.name}...`);
        try {
          const approveTx = await (token.connect(signer) as any).approve(collection.contractAddress, tokenNeeded);
          await approveTx.wait(1);
          console.log(`✅ Approval confirmed: ${approveTx.hash}`);
        } catch (err: any) {
          releaseNonce(walletId);
          throw new Error(`Token approval failed: ${err?.message || err}`);
        }
      }
    }
  }

  // ─── Contract Safety Check ─────────────────────────────────────────
  const safety = await checkContractSafety(collection.contractAddress, collection.chainId, provider);
  if (!safety.safe) {
    releaseNonce(walletId);
    throw new Error(`Safety check failed: ${safety.reasons.join("; ")}`);
  }
  if (safety.warnings.length > 0 && !dryRun) {
    console.warn(`⚠️ Safety warnings for ${collection.name}:`, safety.warnings);
  }

  // Gas estimation
  const gas = await estimateGas(tx, provider);
  if (params.gasLimit) tx.gasLimit = BigInt(params.gasLimit);
  else if (gas.gasLimit) tx.gasLimit = gas.gasLimit;

  if (params.maxFeePerGas) tx.maxFeePerGas = BigInt(params.maxFeePerGas);
  else if (gas.maxFeePerGas) tx.maxFeePerGas = gas.maxFeePerGas;

  if (params.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = BigInt(params.maxPriorityFeePerGas);
  else if (gas.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = gas.maxPriorityFeePerGas;

  // ─── Spend limit check ────────────────────────────────────────────
  if (!dryRun) {
    const [wallet] = await db
      .select({ spendLimit: schema.wallets.spendLimit })
      .from(schema.wallets)
      .where(eq(schema.wallets.id, walletId))
      .limit(1);

    if (wallet?.spendLimit) {
      const spendLimit = BigInt(wallet.spendLimit);
      const txValue: bigint = BigInt(tx.value ?? 0);

      // Calculate total already spent by completed/running jobs
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

      // Estimate gas cost: gasLimit * maxFeePerGas
      const gl: bigint = (tx.gasLimit ?? 500_000n) as bigint;
      const mfp: bigint = (tx.maxFeePerGas ?? 50_000_000_000n) as bigint;
      const estimatedGasCost = gl * mfp;
      const totalCost = txValue + estimatedGasCost;
      const previousSpend = BigInt(spent?.total || 0);

      if (previousSpend + totalCost > spendLimit) {
        releaseNonce(walletId);
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
    releaseNonce(walletId);
    return {
      status: "simulation_failed",
      error: sim.error,
      dryRun: dryRun ?? false,
    };
  }

  // Dry run: stop after simulation
  if (dryRun) {
    releaseNonce(walletId);
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
  } catch (err: any) {
    releaseNonce(walletId);
    throw new Error(`Send failed: ${err?.message || err}`);
  }

  // Wait for confirmation
  const receipt = await response.wait(1);

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

      // Log attempt
      await db.insert(schema.mintAttempts).values({
        id: attemptId,
        jobId,
        txHash: result.txHash,
        status: "submitted",
        gasUsed: result.gasUsed,
        effectiveGasPrice: result.effectiveGasPrice,
        blockNumber: result.blockNumber,
      });

      const finalStatus = result.status === "confirmed" ? "completed" : "failed";

      await db
        .update(schema.mintJobs)
        .set({
          status: finalStatus,
          completedAt: new Date().toISOString(),
          nonce: null,
        })
        .where(eq(schema.mintJobs.id, jobId));

      // Alert on failure
      if (finalStatus === "failed") {
        const [wallet] = await db.select({ label: schema.wallets.label }).from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1);
        const [collection] = await db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1);
        await sendAlert("job_failed", `Job ${jobId.slice(0, 8)} failed: ${wallet?.label || "?"} → ${collection?.name || "?"}`, jobId);
      }

      return result;
    } catch (err: any) {
      lastAttempt++;

      await db.insert(schema.mintAttempts).values({
        id: attemptId,
        jobId,
        status: "failed",
        error: err?.message || String(err),
      });

      await db
        .update(schema.mintJobs)
        .set({ retryCount: lastAttempt, error: err?.message || String(err) })
        .where(eq(schema.mintJobs.id, jobId));

      if (lastAttempt >= job.maxRetries) {
        await db
          .update(schema.mintJobs)
          .set({ status: "failed", completedAt: new Date().toISOString() })
          .where(eq(schema.mintJobs.id, jobId));

        // Alert on final failure
        const [wallet] = await db.select({ label: schema.wallets.label }).from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1);
        const [collection] = await db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1);
        await sendAlert("job_failed", `Job ${jobId.slice(0, 8)} exhausted retries: ${wallet?.label || "?"} → ${collection?.name || "?"} — ${err?.message || err}`, jobId);

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
  } catch (err: any) {
    throw new Error(`Failed to unstick job: ${err?.message}`);
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
  scheduledAt?: string
) {
  const results: { walletId: string; jobId: string; status: string; txHash?: string; error?: string }[] = [];

  for (const walletId of walletIds) {
    const jobId = uuidv4();

    await db.insert(schema.mintJobs).values({
      id: jobId,
      walletId,
      collectionId,
      quantity: quantity || 1,
      useFlashbots: useFlashbots ?? false,
      dryRun: dryRun ?? false,
      scheduledAt: scheduledAt || null,
      status: "pending",
    });

    // If scheduled, don't execute immediately — scheduler picks it up
    if (scheduledAt) {
      results.push({ walletId, jobId, status: "scheduled" });
      continue;
    }

    try {
      const result = await runMintJob(jobId);
      if (result) {
        results.push({
          walletId,
          jobId,
          status: "completed",
          txHash: result.txHash,
        });
      }
    } catch (err: any) {
      results.push({
        walletId,
        jobId,
        status: "failed",
        error: err?.message,
      });
    }
  }

  return results;
}
