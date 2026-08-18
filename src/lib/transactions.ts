import { ethers } from "ethers";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const RECEIPT_WAIT_TIMEOUT_MS = 90_000;

export type PreparedSignedTransaction = {
  nonce: number;
  rawTx: string;
  txHash: string;
  request: ethers.TransactionRequest;
};

export function sequentialNonces(startNonce: number, count: number): number[] {
  if (!Number.isSafeInteger(startNonce) || startNonce < 0) throw new Error("Starting nonce must be a non-negative safe integer");
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error("Nonce ladder size must be between 1 and 100");
  if (startNonce > Number.MAX_SAFE_INTEGER - (count - 1)) throw new Error("Nonce ladder exceeds the safe integer range");
  return Array.from({ length: count }, (_, index) => startNonce + index);
}

/** Atomically reserve and sign a contiguous nonce ladder. The callback must
 * durably persist every signed payload in the same database transaction. This
 * is the primitive used by opt-in dedicated-wallet launch modes; it never
 * broadcasts and therefore cannot spend funds by itself. */
export async function prepareSignedTransactionBatch(
  walletId: string,
  chainId: number,
  signer: ethers.Signer,
  provider: ethers.Provider,
  requests: ethers.TransactionRequest[],
  persist: (prepared: PreparedSignedTransaction[], tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
): Promise<PreparedSignedTransaction[]> {
  if (!requests.length || requests.length > 100) throw new Error("Signed transaction batch must contain between 1 and 100 requests");
  const address = await signer.getAddress();
  const onChainNonce = await provider.getTransactionCount(address, "pending");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${walletId}:${chainId}`}))`);
    const rows = await tx.execute(sql<{ next_nonce: number }>`
      insert into wallet_nonce_state (wallet_id, chain_id, next_nonce, updated_at)
      values (${walletId}, ${chainId}, ${onChainNonce}, ${new Date().toISOString()})
      on conflict (wallet_id, chain_id) do update set
        next_nonce = greatest(wallet_nonce_state.next_nonce, excluded.next_nonce),
        updated_at = excluded.updated_at
      returning next_nonce
    `);
    const startNonce = Number(rows[0]?.next_nonce);
    const nonces = sequentialNonces(startNonce, requests.length);
    const prepared: PreparedSignedTransaction[] = [];
    for (let index = 0; index < requests.length; index += 1) {
      const populated = await signer.populateTransaction({ ...requests[index], nonce: nonces[index], chainId });
      delete populated.from;
      const rawTx = await signer.signTransaction(populated);
      prepared.push({ nonce: nonces[index], rawTx, txHash: ethers.keccak256(rawTx), request: populated });
    }
    await persist(prepared, tx);
    await tx.execute(sql`
      update wallet_nonce_state
      set next_nonce = ${startNonce + requests.length}, updated_at = ${new Date().toISOString()}
      where wallet_id = ${walletId} and chain_id = ${chainId}
    `);
    return prepared;
  });
}

export async function prepareSignedTransaction(
  walletId: string,
  chainId: number,
  signer: ethers.Signer,
  provider: ethers.Provider,
  request: ethers.TransactionRequest,
  persist: (prepared: PreparedSignedTransaction, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
): Promise<PreparedSignedTransaction> {
  const [prepared] = await prepareSignedTransactionBatch(walletId, chainId, signer, provider, [request], async (items, tx) => {
    await persist(items[0], tx);
  });
  return prepared;
}

export async function broadcastPreparedTransaction(
  provider: ethers.Provider,
  rawTx: string,
  expectedHash: string,
): Promise<ethers.TransactionResponse> {
  try {
    const response = await provider.broadcastTransaction(rawTx);
    if (response.hash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error("RPC returned a transaction hash that did not match the persisted signed transaction");
    }
    return response;
  } catch (error) {
    const existing = await provider.getTransaction(expectedHash).catch(() => null);
    if (existing) return existing;
    throw error;
  }
}

export async function waitForReceipt(
  provider: ethers.Provider,
  txHash: string,
  timeoutMs = RECEIPT_WAIT_TIMEOUT_MS,
): Promise<ethers.TransactionReceipt | null> {
  const existing = await provider.getTransactionReceipt(txHash);
  if (existing) return existing;
  return provider.waitForTransaction(txHash, 1, timeoutMs);
}

export function exactSimulationRequest(request: ethers.TransactionRequest, from: string): ethers.TransactionRequest {
  return { ...request, from };
}
