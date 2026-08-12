import type { MintAdapter, MintPhase, ResolvedMint } from "./types";

type AdapterConfig = {
  phases?: Array<{ id?:string; name:string; startsAt?:string; endsAt?:string; priceWei?:string; maxPerWallet?:number }>;
};

function phaseStatus(phase: NonNullable<AdapterConfig["phases"]>[number]): MintPhase["status"] {
  const now = Date.now();
  const starts = phase.startsAt ? Date.parse(phase.startsAt) : NaN;
  const ends = phase.endsAt ? Date.parse(phase.endsAt) : NaN;
  if (Number.isFinite(starts) && now < starts) return "upcoming";
  if (Number.isFinite(ends) && now > ends) return "ended";
  if (Number.isFinite(starts) || Number.isFinite(ends)) return "live";
  return "unknown";
}

export const evmContractV1: MintAdapter = {
  key: "evm-contract-v1",
  async resolve(collection, source): Promise<ResolvedMint> {
    let config: AdapterConfig = {};
    try { config = JSON.parse(collection.adapterConfig || "{}"); } catch { throw new Error("Supported mint has invalid reviewed configuration"); }
    const configured = config.phases || [];
    const phases: MintPhase[] = configured.length ? configured.map((phase, index) => ({
      id: phase.id || `phase-${index + 1}`,
      name: phase.name,
      status: phaseStatus(phase),
      startsAt: phase.startsAt,
      endsAt: phase.endsAt,
      priceWei: phase.priceWei || collection.mintPrice || undefined,
      maxPerWallet: phase.maxPerWallet || collection.maxPerWallet || undefined,
    })) : [{ id:"public", name:"Public", status:"unknown", priceWei:collection.mintPrice || undefined, maxPerWallet:collection.maxPerWallet || undefined }];
    return {
      supported:true, collectionId:collection.id, adapterKey:collection.adapterKey, name:collection.name,
      slug:collection.slug || undefined, chainId:collection.chainId, contractAddress:collection.contractAddress,
      siteUrl:collection.siteUrl || undefined, imageUrl:collection.imageUrl || undefined,
      maxSupply:collection.maxSupply || undefined, phases, source,
    };
  },
};
