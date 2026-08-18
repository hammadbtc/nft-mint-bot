import { ethers } from "ethers";
import reviewed from "../../config/reviewed-bulk-disperse.json";

export type ReviewedBulkDisperse = {
  chainId: number;
  address: string;
  runtimeCodeHash: string;
  auditUrl: string;
  verifiedSourceUrl: string;
};

export function validateReviewedBulkDisperse(entry: ReviewedBulkDisperse): void {
  if (!Number.isSafeInteger(entry.chainId) || entry.chainId < 1) throw new Error("Bulk Disperse chain ID is invalid");
  if (!ethers.isAddress(entry.address)) throw new Error("Bulk Disperse address is invalid");
  if (!ethers.isHexString(entry.runtimeCodeHash, 32)) throw new Error("Bulk Disperse runtime code hash is invalid");
  for (const [label, value] of [["audit", entry.auditUrl], ["verified source", entry.verifiedSourceUrl]] as const) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`Bulk Disperse ${label} URL is invalid`); }
    if (url.protocol !== "https:") throw new Error(`Bulk Disperse ${label} URL must use HTTPS`);
  }
}

export function reviewedBulkDisperseFor(chainId: number): ReviewedBulkDisperse | null {
  const entry = (reviewed as ReviewedBulkDisperse[]).find((item) => item.chainId === chainId);
  if (!entry) return null;
  validateReviewedBulkDisperse(entry);
  return entry;
}

/** Bulk execution must call this immediately before constructing calldata.
 * There is deliberately no automatic fallback to an unknown contract. */
export async function requireVerifiedBulkDisperse(chainId: number, provider: ethers.Provider): Promise<ReviewedBulkDisperse> {
  const entry = reviewedBulkDisperseFor(chainId);
  if (!entry) throw new Error("No audited and source-verified bulk Disperse contract is approved for this chain");
  const code = await provider.getCode(entry.address);
  if (code === "0x" || ethers.keccak256(code).toLowerCase() !== entry.runtimeCodeHash.toLowerCase()) {
    throw new Error("Approved bulk Disperse runtime bytecode does not match the reviewed hash");
  }
  return entry;
}

export function approvedBulkDisperseChains(): number[] {
  return (reviewed as ReviewedBulkDisperse[]).map((entry) => {
    validateReviewedBulkDisperse(entry);
    return entry.chainId;
  });
}
