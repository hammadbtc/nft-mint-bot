import { ethers } from "ethers";
import type { MintAdapter, MintPhase, ResolvedMint } from "./types";

type AdapterConfig = {
  phases?: Array<{ id?:string; name:string; kind?:MintPhase["kind"]; startsAt?:string; endsAt?:string; priceWei?:string; maxPerWallet?:number }>;
};

function phaseStatus(phase: NonNullable<AdapterConfig["phases"]>[number]): MintPhase["status"] {
  const now = Date.now();
  const starts = phase.startsAt ? Date.parse(phase.startsAt) : NaN;
  const ends = phase.endsAt ? Date.parse(phase.endsAt) : NaN;
  if (Number.isFinite(starts) && now < starts) return "upcoming";
  if (Number.isFinite(ends) && now >= ends) return "ended";
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
      kind: phase.kind || "public",
      status: phaseStatus(phase),
      startsAt: phase.startsAt,
      endsAt: phase.endsAt,
      priceWei: phase.priceWei || collection.mintPrice || undefined,
      maxPerWallet: phase.maxPerWallet || collection.maxPerWallet || undefined,
    })) : [{ id:"public", name:"Public", kind:"public", status:"unknown", priceWei:collection.mintPrice || undefined, maxPerWallet:collection.maxPerWallet || undefined }];
    return {
      supported:true, collectionId:collection.id, adapterKey:collection.adapterKey, name:collection.name,
      slug:collection.slug || undefined, chainId:collection.chainId, contractAddress:collection.contractAddress,
      siteUrl:collection.siteUrl || undefined, imageUrl:collection.imageUrl || undefined,
      maxSupply:collection.maxSupply || undefined, phases, source,
    };
  },

  async buildTransaction(collection, _signerAddress, quantity, _provider, options): Promise<ethers.TransactionRequest> {
    let config: AdapterConfig = {};
    try { config = JSON.parse(collection.adapterConfig || "{}"); } catch { throw new Error("Supported mint has invalid reviewed configuration"); }
    const configured = config.phases || [];
    const selected = options?.phaseId
      ? configured.find((phase, index) => (phase.id || `phase-${index + 1}`) === options.phaseId)
      : configured.length === 1 ? configured[0] : undefined;
    if (options?.phaseId && !selected) throw new Error("Unsupported reviewed mint phase selected");
    let mintAbi: ethers.InterfaceAbi;
    try { mintAbi = JSON.parse(collection.mintAbi); }
    catch { throw new Error("Supported mint has an invalid reviewed ABI"); }
    const iface = new ethers.Interface(mintAbi);
    const fragment = iface.getFunction(collection.mintMethod);
    if (!fragment) throw new Error("Reviewed mint function is missing from the ABI");
    let data: string;
    if (fragment.inputs.length === 0) data = iface.encodeFunctionData(fragment, []);
    else if (fragment.inputs.length === 1 && /^u?int/.test(fragment.inputs[0].type)) data = iface.encodeFunctionData(fragment, [quantity]);
    else throw new Error("Generic mint adapter only supports a verified quantity argument or no arguments");
    return {
      to: collection.contractAddress,
      data,
      value: collection.paymentToken ? 0n : BigInt(selected?.priceWei || collection.mintPrice || "0") * BigInt(quantity),
      chainId: collection.chainId,
    };
  },
};
