import type { ethers } from "ethers";
import type { collections } from "@/lib/db/schema";

// Optional in the adapter-facing type so legacy fixtures and external adapter
// packages remain source-compatible. Database rows always provide the field.
export type SupportedCollection = Omit<
  typeof collections.$inferSelect,
  "broadcastPaused" | "broadcastPauseReason" | "broadcastPauseUpdatedAt"
> & {
  broadcastPaused?: boolean;
  broadcastPauseReason?: string | null;
  broadcastPauseUpdatedAt?: string | null;
};

export type MintPhase = {
  id: string;
  name: string;
  kind?: "public" | "allowlist" | "signed" | "token-gated" | "holder" | "unknown";
  status: "upcoming" | "live" | "ended" | "unknown";
  startsAt?: string;
  endsAt?: string;
  priceWei?: string;
  maxPerWallet?: number;
  /** The phase opens through an on-chain owner switch instead of a timestamp. */
  manualOpen?: boolean;
};

export type MintPhaseEligibility = {
  phaseId: string;
  status: "eligible" | "ineligible" | "unknown" | "unsupported";
  reason?: string;
  artifactId?: string;
  artifactHash?: string;
  artifactExpiresAt?: string;
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
  execution?: {
    onePerTransaction: boolean;
    maxPreparedTransactions?: number;
  };
};

export interface MintAdapter {
  key: string;
  supportsArming?: boolean;
  requiresSignerForEligibility?: boolean;
  canArmPhase?: (phaseId: string) => boolean;
  /** True only when this exact phase needs a provider-issued wallet payload
   * before deterministic transaction construction. Mixed adapters must make
   * this decision per phase; method presence is not a capability signal. */
  requiresPayloadWarmup?: (collection: SupportedCollection, phaseId: string) => boolean;
  /** A fully validated, wallet-bound payload is authoritative proof that this
   * wallet may use the phase. Armed-job revalidation must not repeat a remote
   * eligibility/authentication flow on the launch-critical path. */
  prearmedPayloadProvesEligibility?: (collection: SupportedCollection, phaseId: string) => boolean;
  /** Cheap fail-closed readiness probe for phases controlled by an owner switch. */
  pollPhaseReady?: (
    collection: SupportedCollection,
    phaseId: string,
    provider: ethers.Provider,
  ) => Promise<boolean>;
  /** Pinned/current authoritative capacity for one-per-transaction ladders. */
  remainingTransactions?: (
    collection: SupportedCollection,
    phaseId: string,
    signerAddress: string,
    provider: ethers.Provider,
  ) => Promise<number>;
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
    options?: { allowBeforeStart?: boolean; phaseId?: string; eligibilityArtifactId?: string | null; eligibilityArtifactHash?: string | null },
  ) => Promise<ethers.TransactionRequest>;
  /** Acquire and fully validate a wallet-bound provider payload before the
   * stage opens. Implementations must fail closed when the provider does not
   * permit early construction; callers will retry at launch. */
  warmTransaction?: (
    collection: SupportedCollection,
    signerAddress: string,
    quantity: number,
    provider: ethers.Provider,
    options: { phaseId: string },
  ) => Promise<void>;
  revalidateBeforeSigning?: (
    collection: SupportedCollection,
    signerAddress: string,
    quantity: number,
    provider: ethers.Provider,
    request: ethers.TransactionRequest,
    options?: { phaseId?: string; eligibilityArtifactId?: string | null; eligibilityArtifactHash?: string | null },
  ) => Promise<void>;
  recommendedGasLimit?: bigint;
}
