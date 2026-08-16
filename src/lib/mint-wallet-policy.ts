export type MintWalletCandidate = {
  active: boolean;
  role: string;
  parentWalletId: string | null;
  chainId: number;
};

export function mintWalletEligibilityError(
  wallet: MintWalletCandidate,
  requiredChainId: number,
  parent?: MintWalletCandidate,
): string | null {
  void requiredChainId;
  if (!wallet.active) return "Selected mint wallet is inactive";
  if (wallet.role === "main") return null;
  if (wallet.role !== "worker" || !wallet.parentWalletId) return "Selected wallet has an invalid mint role";
  if (!parent || !parent.active || parent.role !== "main") return "Worker wallet requires an active main wallet";
  return null;
}
