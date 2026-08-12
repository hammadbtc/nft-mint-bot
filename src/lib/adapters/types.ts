import type { ethers } from "ethers";
import type { collections } from "@/lib/db/schema";

export type SupportedCollection = typeof collections.$inferSelect;

export type MintPhase = {
  id: string;
  name: string;
  status: "upcoming" | "live" | "ended" | "unknown";
  startsAt?: string;
  endsAt?: string;
  priceWei?: string;
  maxPerWallet?: number;
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
  phases: MintPhase[];
  source: "url" | "contract" | "name";
};

export interface MintAdapter {
  key: string;
  resolve(collection: SupportedCollection, source: ResolvedMint["source"]): Promise<ResolvedMint>;
  buildTransaction?: (
    collection: SupportedCollection,
    signerAddress: string,
    quantity: number,
    provider: ethers.Provider,
  ) => Promise<ethers.TransactionRequest>;
}
