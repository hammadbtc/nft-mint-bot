import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getProvider } from "@/lib/chains";
import { getSigner } from "@/lib/vault";
import { broadcastPreparedTransaction, prepareSignedTransaction, waitForReceipt } from "@/lib/transactions";
import { liveTransactionsEnabled, requireLiveTransactions, safeErrorMessage, stableHash, stableJson } from "@/lib/safety";

const PREVIEW_TTL_MS = 60_000;
const OPERATION_LEASE_MS = 120_000;

export type DisperseInput = {
  type: "fund" | "sweep";
  mainWalletId: string;
  workerWalletIds: string[];
  amountPerWallet?: string;
};

export type DisperseTransferPlan = {
  fromWalletId: string;
  toWalletId: string;
  amountWei: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string | null;
};

export type DispersePreview = {
  version: 2;
  type: "fund" | "sweep";
  mainWalletId: string;
  workerWalletIds: string[];
  chainId: number;
  transfers: DisperseTransferPlan[];
  estimatedGasWei: string;
  totalRequiredWei: string;
  generatedAt: string;
  expiresAt: string;
  fingerprint: string;
};

async function walletSet(input: DisperseInput) {
  const [main] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, input.mainWalletId)).limit(1);
  if (!main || main.role !== "main" || !main.active) throw new Error("Main wallet is unavailable");
  const ids = [...new Set(input.workerWalletIds)].sort();
  const workers = ids.length ? await db.select().from(schema.wallets).where(inArray(schema.wallets.id, ids)) : [];
  if (workers.length !== ids.length) throw new Error("One or more worker wallets were not found");
  if (workers.some((worker) => worker.role !== "worker" || worker.parentWalletId !== main.id || worker.chainId !== main.chainId || !worker.active)) {
    throw new Error("Workers must be active children of the selected main wallet on the same network");
  }
  return { main, workers: workers.sort((a, b) => a.id.localeCompare(b.id)), ids };
}

function fingerprintValue(preview: Omit<DispersePreview, "fingerprint" | "generatedAt" | "expiresAt">): string {
  return stableHash(preview);
}

export async function previewDisperse(input: DisperseInput): Promise<DispersePreview> {
  const { main, workers, ids } = await walletSet(input);
  const provider = getProvider(main.chainId);
  const fees = await provider.getFeeData();
  const baseMaxFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (baseMaxFee == null || baseMaxFee <= 0n) throw new Error("RPC did not return a usable network fee");
  const maxFee = (baseMaxFee * 125n) / 100n;
  const priority = fees.maxPriorityFeePerGas == null ? null : (fees.maxPriorityFeePerGas * 125n) / 100n;
  const transfers: DisperseTransferPlan[] = [];

  if (input.type === "fund") {
    if (!input.amountPerWallet) throw new Error("Amount per worker is required");
    const amount = ethers.parseEther(input.amountPerWallet);
    if (amount <= 0n) throw new Error("Amount must be positive");
    for (const worker of workers) {
      const estimated = await provider.estimateGas({ from: main.address, to: worker.address, value: amount });
      transfers.push({
        fromWalletId: main.id,
        toWalletId: worker.id,
        amountWei: amount.toString(),
        gasLimit: ((estimated * 120n) / 100n).toString(),
        maxFeePerGas: maxFee.toString(),
        maxPriorityFeePerGas: priority?.toString() || null,
      });
    }
  } else {
    for (const worker of workers) {
      const [balance, estimated] = await Promise.all([
        provider.getBalance(worker.address),
        provider.estimateGas({ from: worker.address, to: main.address, value: 0n }),
      ]);
      const gasLimit = (estimated * 120n) / 100n;
      const reserve = gasLimit * maxFee;
      const amount = balance > reserve ? balance - reserve : 0n;
      if (amount > 0n) transfers.push({
        fromWalletId: worker.id,
        toWalletId: main.id,
        amountWei: amount.toString(),
        gasLimit: gasLimit.toString(),
        maxFeePerGas: maxFee.toString(),
        maxPriorityFeePerGas: priority?.toString() || null,
      });
    }
    if (!transfers.length) throw new Error("Selected workers have no sweepable balance after the reviewed gas reserve");
  }

  const gasTotal = transfers.reduce((total, transfer) => total + BigInt(transfer.gasLimit) * BigInt(transfer.maxFeePerGas), 0n);
  const valueTotal = transfers.reduce((total, transfer) => total + BigInt(transfer.amountWei), 0n);
  if (input.type === "fund") {
    const balance = await provider.getBalance(main.address);
    if (balance < valueTotal + gasTotal) throw new Error(`Main wallet needs up to ${ethers.formatEther(valueTotal + gasTotal)} native tokens`);
  }

  const core = {
    version: 2 as const,
    type: input.type,
    mainWalletId: main.id,
    workerWalletIds: ids,
    chainId: main.chainId,
    transfers,
    estimatedGasWei: gasTotal.toString(),
    totalRequiredWei: (input.type === "fund" ? valueTotal + gasTotal : valueTotal).toString(),
  };
  const generatedAt = new Date().toISOString();
  return {
    ...core,
    generatedAt,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    fingerprint: fingerprintValue(core),
  };
}

export async function queueDisperse(input: DisperseInput, expected: DispersePreview, idempotencyKey: string) {
  if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("A valid Idempotency-Key header is required");
  if (expected.version !== 2 || Date.now() > Date.parse(expected.expiresAt)) throw new Error("Disperse preview expired; review current balances and fees again");
  const current = await previewDisperse(input);
  if (current.fingerprint !== expected.fingerprint) throw new Error("Balances, fees, or selected wallets changed; review the updated preview");
  const requestHash = stableHash({ ...input, workerWalletIds: [...new Set(input.workerWalletIds)].sort() });
  const operationId = randomUUID();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`);
    const [existing] = await tx.select().from(schema.disperseOperations)
      .where(eq(schema.disperseOperations.idempotencyKey, idempotencyKey)).limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("Idempotency key was already used for a different Disperse request");
      return { operationId: existing.id, status: existing.status, duplicate: true };
    }
    await tx.insert(schema.disperseOperations).values({
      id: operationId,
      type: input.type,
      mainWalletId: input.mainWalletId,
      chainId: current.chainId,
      status: "pending",
      idempotencyKey,
      requestHash,
      previewJson: stableJson(current),
      amountPerWallet: input.amountPerWallet ? ethers.parseEther(input.amountPerWallet).toString() : null,
    });
    await tx.insert(schema.disperseTransfers).values(current.transfers.map((transfer) => ({
      id: randomUUID(),
      operationId,
      fromWalletId: transfer.fromWalletId,
      toWalletId: transfer.toWalletId,
      amount: transfer.amountWei,
      gasLimit: transfer.gasLimit,
      maxFeePerGas: transfer.maxFeePerGas,
      maxPriorityFeePerGas: transfer.maxPriorityFeePerGas,
      status: "pending",
    })));
    return { operationId, status: "pending", duplicate: false };
  });
}

async function runTransfer(transferId: string, chainId: number): Promise<"confirmed" | "confirming" | "failed"> {
  const [transfer] = await db.select().from(schema.disperseTransfers).where(eq(schema.disperseTransfers.id, transferId)).limit(1);
  if (!transfer) throw new Error("Disperse transfer was not found");
  if (transfer.status === "confirmed") return "confirmed";
  const [[from], [to]] = await Promise.all([
    db.select().from(schema.wallets).where(eq(schema.wallets.id, transfer.fromWalletId)).limit(1),
    db.select().from(schema.wallets).where(eq(schema.wallets.id, transfer.toWalletId)).limit(1),
  ]);
  if (!from || !to || !from.active || !to.active || from.chainId !== chainId || to.chainId !== chainId) {
    throw new Error("Disperse wallet state changed after review");
  }
  const provider = getProvider(chainId);
  const signer = await getSigner(from.id, provider);
  const fees = await provider.getFeeData();
  const currentFee = fees.maxFeePerGas ?? fees.gasPrice;
  if (currentFee == null || currentFee > BigInt(transfer.maxFeePerGas || "0")) throw new Error("Network fee exceeded the reviewed cap; create a fresh Disperse preview");

  let rawTx = transfer.rawTx;
  let txHash = transfer.txHash;
  if (!rawTx || !txHash) {
    const request: ethers.TransactionRequest = {
      to: to.address,
      value: BigInt(transfer.amount),
      chainId,
      gasLimit: BigInt(transfer.gasLimit || "0"),
      ...(transfer.maxPriorityFeePerGas
        ? { maxFeePerGas: BigInt(transfer.maxFeePerGas || "0"), maxPriorityFeePerGas: BigInt(transfer.maxPriorityFeePerGas) }
        : { gasPrice: BigInt(transfer.maxFeePerGas || "0") }),
    };
    const balance = await provider.getBalance(from.address);
    const maximum = BigInt(transfer.amount) + BigInt(transfer.gasLimit || "0") * BigInt(transfer.maxFeePerGas || "0");
    if (balance < maximum) throw new Error("Source wallet no longer has the reviewed transfer plus gas reserve");
    await provider.call({ ...request, from: from.address });
    const prepared = await prepareSignedTransaction(from.id, chainId, signer, provider, request, async (signed, tx) => {
      const updated = await tx.update(schema.disperseTransfers).set({
        status: "prepared",
        nonce: signed.nonce,
        rawTx: signed.rawTx,
        txHash: signed.txHash,
        preparedAt: new Date().toISOString(),
        error: null,
      }).where(and(eq(schema.disperseTransfers.id, transfer.id), eq(schema.disperseTransfers.status, "pending")))
        .returning({ id: schema.disperseTransfers.id });
      if (!updated.length) throw new Error("Transfer was claimed or prepared by another worker");
    });
    rawTx = prepared.rawTx;
    txHash = prepared.txHash;
  }

  const existingReceipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!existingReceipt) {
    requireLiveTransactions();
    try {
      await broadcastPreparedTransaction(provider, rawTx, txHash);
      await db.update(schema.disperseTransfers).set({ status: "submitted", broadcastAt: new Date().toISOString(), error: null })
        .where(eq(schema.disperseTransfers.id, transfer.id));
    } catch (error) {
      const existing = await provider.getTransaction(txHash).catch(() => null);
      await db.update(schema.disperseTransfers).set({
        status: existing ? "submitted" : "prepared",
        error: safeErrorMessage(error, "Broadcast failed; exact signed transfer is retained for recovery"),
      }).where(eq(schema.disperseTransfers.id, transfer.id));
      if (!existing) throw error;
    }
  }

  const receipt = existingReceipt || await waitForReceipt(provider, txHash);
  if (!receipt) {
    await db.update(schema.disperseTransfers).set({ status: "confirming" }).where(eq(schema.disperseTransfers.id, transfer.id));
    return "confirming";
  }
  const confirmed = receipt.status === 1;
  await db.update(schema.disperseTransfers).set({
    status: confirmed ? "confirmed" : "failed",
    rawTx: null,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.gasPrice.toString(),
    blockNumber: receipt.blockNumber,
    confirmedAt: new Date().toISOString(),
    error: confirmed ? null : "Transfer receipt reported failure",
  }).where(eq(schema.disperseTransfers.id, transfer.id));
  return confirmed ? "confirmed" : "failed";
}

export async function runDisperseOperation(operationId: string): Promise<void> {
  const [operation] = await db.select().from(schema.disperseOperations).where(eq(schema.disperseOperations.id, operationId)).limit(1);
  if (!operation || ["completed", "failed", "partial", "cancelled"].includes(operation.status)) return;
  const transfers = await db.select().from(schema.disperseTransfers)
    .where(eq(schema.disperseTransfers.operationId, operationId)).orderBy(asc(schema.disperseTransfers.createdAt));
  let confirming = false;
  let failed = false;
  for (const transfer of transfers) {
    try {
      const result = await runTransfer(transfer.id, operation.chainId);
      confirming ||= result === "confirming";
      failed ||= result === "failed";
      if (confirming) break;
    } catch (error) {
      failed = true;
      const [current] = await db.select({ txHash: schema.disperseTransfers.txHash, rawTx: schema.disperseTransfers.rawTx })
        .from(schema.disperseTransfers).where(eq(schema.disperseTransfers.id, transfer.id)).limit(1);
      const recoverable = Boolean(current?.txHash && current?.rawTx);
      await db.update(schema.disperseTransfers).set({ status: recoverable ? "prepared" : "failed", error: safeErrorMessage(error) })
        .where(eq(schema.disperseTransfers.id, transfer.id));
      if (recoverable) confirming = true;
      break;
    }
  }
  const refreshed = await db.select({ status: schema.disperseTransfers.status }).from(schema.disperseTransfers)
    .where(eq(schema.disperseTransfers.operationId, operationId));
  const confirmedCount = refreshed.filter((item) => item.status === "confirmed").length;
  const failedCount = refreshed.filter((item) => item.status === "failed").length;
  const hasInFlight = confirming || refreshed.some((item) => ["prepared", "submitted", "confirming"].includes(item.status));
  const hasPending = refreshed.some((item) => item.status === "pending");
  const status = hasInFlight
    ? "confirming"
    : failed || failedCount
      ? confirmedCount ? "partial" : "failed"
      : hasPending ? "pending" : "completed";
  await db.update(schema.disperseOperations).set({
    status,
    completedAt: ["completed", "failed", "partial"].includes(status) ? new Date().toISOString() : null,
    claimToken: status === "confirming" ? operation.claimToken : null,
    claimedAt: status === "confirming" ? operation.claimedAt : null,
    leaseExpiresAt: status === "confirming" ? new Date(Date.now() + OPERATION_LEASE_MS).toISOString() : null,
    updatedAt: new Date().toISOString(),
    error: failedCount ? `${failedCount} transfer(s) failed` : null,
  }).where(eq(schema.disperseOperations.id, operationId));
}

export async function processDisperseOperations(limit = 2): Promise<number> {
  if (!liveTransactionsEnabled()) return 0;
  const operations = await db.select().from(schema.disperseOperations)
    .where(eq(schema.disperseOperations.status, "pending"))
    .orderBy(asc(schema.disperseOperations.createdAt)).limit(limit);
  let count = 0;
  for (const operation of operations) {
    const now = new Date().toISOString();
    const claimed = await db.update(schema.disperseOperations).set({
      status: "running",
      claimToken: randomUUID(),
      claimedAt: now,
      leaseExpiresAt: new Date(Date.now() + OPERATION_LEASE_MS).toISOString(),
      updatedAt: now,
    }).where(and(eq(schema.disperseOperations.id, operation.id), eq(schema.disperseOperations.status, "pending")))
      .returning({ id: schema.disperseOperations.id });
    if (!claimed.length) continue;
    await runDisperseOperation(operation.id);
    count += 1;
  }
  return count;
}

export async function recoverDisperseOperation(operationId: string): Promise<void> {
  await runDisperseOperation(operationId);
}
