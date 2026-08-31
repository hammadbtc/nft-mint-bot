import { ethers } from "ethers";
import type { MintAdapter, MintPhase, MintPhaseEligibility, ResolvedMint, SupportedCollection } from "./types";
import {
  compileReviewedTransaction,
  resolveBindingValues,
  reviewedPhaseStatus,
  validateReviewedCallConfig,
  type ReviewedCallPhase,
} from "@/lib/reviewed-call-config";
import { loadEligibilityArtifact } from "@/lib/eligibility-artifacts";
import { hashMintDefinition, snapshotCollectionDefinition } from "@/lib/mint-definitions";
import { getProvider } from "@/lib/chains";

const BALANCE_OF_ABI = ["function balanceOf(address owner) view returns (uint256)"];

function phaseById(collection: SupportedCollection, phaseId?: string): ReviewedCallPhase {
  const config = validateReviewedCallConfig(collection);
  const phase = phaseId ? config.phases.find((item) => item.id === phaseId) : config.phases.length === 1 ? config.phases[0] : undefined;
  if (!phase) throw new Error(phaseId ? "Selected reviewed phase is unavailable" : "A reviewed phase must be selected");
  return phase;
}

function mintPhase(phase: ReviewedCallPhase, manualOpen?: boolean): MintPhase {
  return {
    id: phase.id,
    name: phase.name,
    kind: phase.kind,
    status: reviewedPhaseStatus(phase, manualOpen),
    startsAt: phase.opening.mode === "time" ? phase.opening.startsAt : undefined,
    endsAt: phase.opening.mode === "time" ? phase.opening.endsAt : undefined,
    priceWei: phase.unitPriceWei,
    maxPerWallet: phase.maxPerWallet,
    manualOpen: phase.opening.mode === "manual",
  };
}

function definitionHash(collection: SupportedCollection): string {
  return hashMintDefinition(snapshotCollectionDefinition(collection));
}

function iface(collection: SupportedCollection): ethers.Interface {
  return new ethers.Interface(JSON.parse(collection.mintAbi) as ethers.InterfaceAbi);
}

async function readBool(input: {
  collection: SupportedCollection;
  target: string;
  signature: string;
  bindings: ReviewedCallPhase["call"]["args"];
  wallet: string;
  quantity: number;
  provider: ethers.Provider;
}): Promise<boolean> {
  const contractInterface = iface(input.collection);
  const fragment = contractInterface.getFunction(input.signature);
  if (!fragment) throw new Error("Reviewed bool function is unavailable");
  const data = contractInterface.encodeFunctionData(fragment, resolveBindingValues(input.bindings, { wallet: input.wallet, quantity: input.quantity }));
  const raw = await input.provider.call({ to: input.target, data });
  const result = contractInterface.decodeFunctionResult(fragment, raw);
  return result[0] === true;
}

async function eligibilityForPhase(
  collection: SupportedCollection,
  phase: ReviewedCallPhase,
  signerAddress: string,
  quantity: number,
  provider: ethers.Provider,
): Promise<MintPhaseEligibility> {
  if (quantity > phase.maxPerWallet) return { phaseId: phase.id, status: "ineligible", reason: `Quantity exceeds the ${phase.maxPerWallet} wallet limit` };
  const strategy = phase.eligibility;
  if (strategy.strategy === "public") return { phaseId: phase.id, status: "eligible" };
  if (strategy.strategy === "token-balance-v1") {
    const token = new ethers.Contract(strategy.token, BALANCE_OF_ABI, provider);
    const balance = BigInt(await token.getFunction("balanceOf").staticCall(signerAddress));
    return balance >= BigInt(strategy.minimum)
      ? { phaseId: phase.id, status: "eligible" }
      : { phaseId: phase.id, status: "ineligible", reason: `Token balance is below the reviewed minimum ${strategy.minimum}` };
  }
  if (strategy.strategy === "onchain-bool-v1") {
    const eligible = await readBool({ collection, target: strategy.target, signature: strategy.function, bindings: strategy.args, wallet: signerAddress, quantity, provider });
    return eligible ? { phaseId: phase.id, status: "eligible" } : { phaseId: phase.id, status: "ineligible", reason: "The reviewed on-chain eligibility check returned false" };
  }
  const artifact = await loadEligibilityArtifact({
    collectionId: collection.id,
    definitionHash: definitionHash(collection),
    phase,
    walletAddress: signerAddress,
  });
  return artifact
    ? { phaseId: phase.id, status: "eligible", artifactId: artifact.id, artifactHash: artifact.artifactHash, artifactExpiresAt: artifact.expiresAt || undefined }
    : { phaseId: phase.id, status: "ineligible", reason: `No valid ${strategy.strategy === "merkle-proof-v1" ? "allowlist proof" : "server signature"} is loaded for this wallet` };
}

export const reviewedCallV1: MintAdapter = {
  key: "reviewed-call-v1",
  supportsArming: true,
  canArmPhase: () => true,
  async resolve(collection, source): Promise<ResolvedMint> {
    const config = validateReviewedCallConfig(collection);
    const provider = getProvider(collection.chainId);
    const phases = await Promise.all(config.phases.map(async (phase) => {
      if (phase.opening.mode !== "manual") return mintPhase(phase);
      const open = await readBool({
        collection,
        target: phase.opening.target,
        signature: phase.opening.function,
        bindings: phase.opening.args,
        wallet: ethers.ZeroAddress,
        quantity: 1,
        provider,
      }).catch(() => false);
      return mintPhase(phase, open);
    }));
    return {
      supported: true,
      collectionId: collection.id,
      adapterKey: collection.adapterKey,
      name: collection.name,
      slug: collection.slug || undefined,
      chainId: collection.chainId,
      contractAddress: collection.contractAddress,
      siteUrl: collection.siteUrl || undefined,
      imageUrl: collection.imageUrl || undefined,
      maxSupply: collection.maxSupply || undefined,
      phases,
      source,
    };
  },
  async checkEligibility(collection, signerAddress, quantity, provider, phases) {
    const config = validateReviewedCallConfig(collection);
    const configured = new Map(config.phases.map((phase) => [phase.id, phase]));
    return Promise.all(phases.map((phase) => {
      const reviewed = configured.get(phase.id);
      return reviewed ? eligibilityForPhase(collection, reviewed, signerAddress, quantity, provider) : Promise.resolve({ phaseId: phase.id, status: "unsupported" as const, reason: "Phase is absent from the reviewed configuration" });
    }));
  },
  async pollPhaseReady(collection, phaseId, provider) {
    const phase = phaseById(collection, phaseId);
    if (phase.opening.mode !== "manual") return reviewedPhaseStatus(phase) === "live";
    return readBool({ collection, target: phase.opening.target, signature: phase.opening.function, bindings: phase.opening.args, wallet: ethers.ZeroAddress, quantity: 1, provider });
  },
  async buildTransaction(collection, signerAddress, quantity, _provider, options) {
    const phase = phaseById(collection, options?.phaseId);
    let artifact;
    if (!["public", "token-balance-v1", "onchain-bool-v1"].includes(phase.eligibility.strategy)) {
      if (!options?.eligibilityArtifactId || !options.eligibilityArtifactHash) {
        throw new Error("Gated mint execution requires an immutable eligibility artifact pin");
      }
      artifact = await loadEligibilityArtifact({
        collectionId: collection.id,
        definitionHash: definitionHash(collection),
        phase,
        walletAddress: signerAddress,
        pinnedId: options?.eligibilityArtifactId,
        pinnedHash: options?.eligibilityArtifactHash,
      });
      if (!artifact) throw new Error("The pinned wallet eligibility artifact is missing or expired");
    }
    return compileReviewedTransaction({ collection, phase, wallet: signerAddress, quantity, artifact: artifact?.payload });
  },
  async revalidateBeforeSigning(collection, signerAddress, quantity, provider, request, options) {
    const phase = phaseById(collection, options?.phaseId);
    const eligibility = await eligibilityForPhase(collection, phase, signerAddress, quantity, provider);
    if (eligibility.status !== "eligible") throw new Error(eligibility.reason || "Wallet is no longer eligible for the reviewed phase");
    const expected = await this.buildTransaction!(collection, signerAddress, quantity, provider, options);
    if (String(expected.to).toLowerCase() !== String(request.to).toLowerCase()
      || String(expected.data).toLowerCase() !== String(request.data).toLowerCase()
      || BigInt(expected.value || 0) !== BigInt(request.value || 0)) {
      throw new Error("Reviewed transaction changed during final revalidation");
    }
    if (phase.opening.mode === "manual" && !(await this.pollPhaseReady!(collection, phase.id, provider))) throw new Error("Manual mint opening is no longer active");
  },
};
