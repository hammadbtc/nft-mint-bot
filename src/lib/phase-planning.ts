import { getMintAdapter } from "@/lib/adapters";
import type { MintPhase, MintPhaseEligibility, SupportedCollection } from "@/lib/adapters/types";
import { getProvider } from "@/lib/chains";
import { selectEligibleExecutionPhase } from "@/lib/mint-policy";

export type WalletPhasePlan = {
  phases: MintPhase[];
  eligibility: MintPhaseEligibility[];
  selectedPhase: MintPhase;
};

/**
 * Resolve every reviewed stage, check it for one wallet, then choose the first
 * eligible live stage or earliest eligible upcoming stage. Adapters which
 * expose only universally-open phases may omit checkEligibility.
 */
export async function inspectWalletPhases(
  collection: SupportedCollection,
  signerAddress: string,
  quantity: number,
  knownPhases?: MintPhase[],
): Promise<Omit<WalletPhasePlan, "selectedPhase">> {
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter) throw new Error("The reviewed mint adapter is unavailable");
  const phases = knownPhases || (await adapter.resolve(collection, "name")).phases;
  if (!phases.length) throw new Error("The reviewed mint has no phases");
  if (new Set(phases.map((phase) => phase.id)).size !== phases.length) {
    throw new Error("The reviewed mint returned duplicate phase identifiers");
  }
  const provider = getProvider(collection.chainId);
  const eligibility = adapter.checkEligibility
    ? await adapter.checkEligibility(collection, signerAddress, quantity, provider, phases)
    : phases.map((phase) => phase.kind && phase.kind !== "public"
      ? { phaseId: phase.id, status: "unsupported" as const, reason: `${phase.name} requires a reviewed wallet-eligibility adapter` }
      : { phaseId: phase.id, status: "eligible" as const });
  const byId = new Map(eligibility.map((item) => [item.phaseId, item]));
  const complete = phases.map((phase) => {
    const result = byId.get(phase.id) || ({ phaseId: phase.id, status: "unknown" as const, reason: "Eligibility could not be verified" });
    if (result.status === "eligible" && phase.maxPerWallet && quantity > phase.maxPerWallet) {
      return { phaseId: phase.id, status: "ineligible" as const, reason: `Quantity exceeds the ${phase.maxPerWallet} wallet limit` };
    }
    return result;
  });
  return { phases, eligibility: complete };
}

export async function resolveWalletPhasePlan(
  collection: SupportedCollection,
  signerAddress: string,
  quantity: number,
  knownPhases?: MintPhase[],
): Promise<WalletPhasePlan> {
  const inspected = await inspectWalletPhases(collection, signerAddress, quantity, knownPhases);
  return { ...inspected, selectedPhase: selectEligibleExecutionPhase(inspected.phases, inspected.eligibility) };
}
