import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { db, schema } from "@/lib/db";
import { getSigner } from "@/lib/vault";
import { getProvider, getChain } from "@/lib/chains";
import { eq } from "drizzle-orm";

// ─── Nonce Manager (in-process) ────────────────────────────────────────
// Per-wallet nonce tracking to avoid nonce gaps
const nonceLock = new Map<string, Promise<void>>();
const nonceCache = new Map<string, number>(); // walletId -> next nonce

async function acquireNonce(
  walletId: string,
  address: string,
  provider: ethers.Provider
): Promise<number> {
  // Wait for any in-flight transaction for this wallet
  while (nonceLock.has(walletId)) {
    await nonceLock.get(walletId);
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  nonceLock.set(walletId, lock);

  try {
    // Get on-chain nonce, but use our cache if it's higher
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

    // Add 20% buffer to gas limit
    const bufferedLimit = (gasLimit * 120n) / 100n;

    return {
      gasLimit: bufferedLimit,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    };
  } catch (err) {
    console.warn("Gas estimation failed, using defaults:", err);
    return {
      gasLimit: 500_000n,
    };
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

// ─── Mint Job Execution ────────────────────────────────────────────────

export interface MintJobParams {
  walletId: string;
  collectionId: string;
  quantity?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

/**
 * Execute a single mint attempt for a job.
 */
export async function executeMint(params: MintJobParams) {
  const { walletId, collectionId } = params;

  // Fetch collection
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);

  if (!collection) throw new Error(`Collection ${collectionId} not found`);

  const chain = getChain(collection.chainId);
  const provider = getProvider(collection.chainId);
  const signer = await getSigner(walletId, provider);

  // Parse ABI
  let mintAbi: any;
  try {
    mintAbi = JSON.parse(collection.mintAbi);
  } catch {
    throw new Error(`Invalid ABI for collection ${collection.name}`);
  }

  const contract = new ethers.Contract(collection.contractAddress, mintAbi, signer);

  // Build transaction data using the contract interface
  const mintFn = contract.getFunction(collection.mintMethod);
  let txData: string;

  try {
    // Try with quantity param first
    const populated = await mintFn.populateTransaction(params.quantity || 1);
    txData = populated.data!;
  } catch {
    // Fallback: mint with no args
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

  // Attach value if mint has a price
  if (collection.mintPrice) {
    tx.value = BigInt(collection.mintPrice) * BigInt(params.quantity || 1);
  }

  // Gas estimation
  const gas = await estimateGas(tx, provider);
  if (params.gasLimit) tx.gasLimit = BigInt(params.gasLimit);
  else if (gas.gasLimit) tx.gasLimit = gas.gasLimit;

  if (params.maxFeePerGas) tx.maxFeePerGas = BigInt(params.maxFeePerGas);
  else if (gas.maxFeePerGas) tx.maxFeePerGas = gas.maxFeePerGas;

  if (params.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = BigInt(params.maxPriorityFeePerGas);
  else if (gas.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = gas.maxPriorityFeePerGas;

  // Simulate
  const sim = await simulateTx(tx, provider);
  if (!sim.success) {
    releaseNonce(walletId);
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  // Send
  let response: ethers.TransactionResponse;
  try {
    response = await signer.sendTransaction(tx);
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
  };
}

/**
 * Run a full mint job: create attempt records, execute, handle retries.
 */
export async function runMintJob(jobId: string) {
  const [job] = await db
    .select()
    .from(schema.mintJobs)
    .where(eq(schema.mintJobs.id, jobId))
    .limit(1);

  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status === "cancelled") return;

  // Mark as running
  await db
    .update(schema.mintJobs)
    .set({ status: "running", startedAt: new Date().toISOString() })
    .where(eq(schema.mintJobs.id, jobId));

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
      });

      // Log successful attempt
      await db.insert(schema.mintAttempts).values({
        id: attemptId,
        jobId,
        txHash: result.txHash,
        status: "submitted",
        gasUsed: result.gasUsed,
        effectiveGasPrice: result.effectiveGasPrice,
        blockNumber: result.blockNumber,
      });

      // Update job as complete
      await db
        .update(schema.mintJobs)
        .set({
          status: result.status === "confirmed" ? "completed" : "failed",
          completedAt: new Date().toISOString(),
          nonce: null, // release nonce track
        })
        .where(eq(schema.mintJobs.id, jobId));

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
        throw err;
      }

      // Exponential backoff before retry
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, lastAttempt)));
    }
  }
}

/**
 * Batch mint: create jobs for all wallets against a collection and execute.
 */
export async function batchMint(collectionId: string, walletIds: string[], quantity?: number) {
  const results: { walletId: string; jobId: string; status: string; txHash?: string; error?: string }[] = [];

  for (const walletId of walletIds) {
    const jobId = uuidv4();

    await db.insert(schema.mintJobs).values({
      id: jobId,
      walletId,
      collectionId,
      quantity: quantity || 1,
      status: "pending",
    });

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
