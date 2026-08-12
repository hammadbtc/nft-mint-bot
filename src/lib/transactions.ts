import { ethers } from "ethers";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const RECEIPT_WAIT_TIMEOUT_MS = 90_000;

type PreparedSignedTransaction = {
  nonce: number;
  rawTx: string;
  txHash: string;
  request: ethers.TransactionRequest;
};

export async function prepareSignedTransaction(
  walletId: string,
  chainId: number,
  signer: ethers.Signer,
  provider: ethers.Provider,
  request: ethers.TransactionRequest,
  persist: (prepared: PreparedSignedTransaction, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
): Promise<PreparedSignedTransaction> {
  const address = await signer.getAddress();
  const onChainNonce = await provider.getTransactionCount(address, "pending");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${walletId}))`);
    const rows = await tx.execute(sql<{ next_nonce: number }>`
      insert into wallet_nonce_state (wallet_id, chain_id, next_nonce, updated_at)
      values (${walletId}, ${chainId}, ${onChainNonce}, ${new Date().toISOString()})
      on conflict (wallet_id) do update set
        chain_id = excluded.chain_id,
        next_nonce = greatest(wallet_nonce_state.next_nonce, excluded.next_nonce),
        updated_at = excluded.updated_at
      returning next_nonce
    `);
    const nonce = Number(rows[0]?.next_nonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Could not reserve a valid wallet nonce");

    const populated = await signer.populateTransaction({ ...request, nonce, chainId });
    delete populated.from;
    const rawTx = await signer.signTransaction(populated);
    const txHash = ethers.keccak256(rawTx);
    const prepared = { nonce, rawTx, txHash, request: populated };

    await persist(prepared, tx);
    await tx.execute(sql`
      update wallet_nonce_state
      set next_nonce = ${nonce + 1}, updated_at = ${new Date().toISOString()}
      where wallet_id = ${walletId}
    `);
    return prepared;
  });
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
