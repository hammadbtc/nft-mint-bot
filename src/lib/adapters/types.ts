import type { ethers } from "ethers";
import type { collections } from "@/lib/db/schema";

export type SupportedCollection = typeof collections.$inferSelect;

export type MintPhase = {
  id: string;
  name: string;
  kind?: "public" | "allowlist" | "signed" | "token-gated" | "holder" | "unknown";
  status: "upcoming" | "live" | "ended" | "unknown";
  startsAt?: string;
  endsAt?: string;
  priceWei?: string;
  maxPerWallet?: number;
};

export type MintPhaseEligibility = {
  phaseId: string;
  status: "eligible" | "ineligible" | "unknown" | "unsupported";
  reason?: string;
};

export type ResolvedMint = {
  supported: true;
  collectionId: string;
  adapterKey: string;
  name: string;
  slug?: string;
  chainId: number;
  contractAddress: string;
  siteUrl?: string;
  imageUrl?: string;
  maxSupply?: number;
  currentSupply?: number;
  phases: MintPhase[];
  source: "url" | "contract" | "name";
};

export interface MintAdapter {
  key: string;
  supportsArming?: boolean;
  requiresSignerForEligibility?: boolean;
  canArmPhase?: (phaseId: string) => boolean;
  resolve(collection: SupportedCollection, source: ResolvedMint["source"]): Promise<ResolvedMint>;
  checkEligibility?: (
    collection: SupportedCollection,
    signerAddress: string,
    quantity: number,
    provider: ethers.Provider,
    phases: MintPhase[],
    context?: { signer?: ethers.Signer },
  ) => Promise<MintPhaseEligibility[]>;
  buildTransaction?: (
    collection: SupportedCollection,
    signerAddress: string,
    quantity: number,
    provider: ethers.Provider,
    options?: { allowBeforeStart?: boolean; phaseId?: string },
  ) => Promise<ethers.TransactionRequest>;
  recommendedGasLimit?: bigint;
}
