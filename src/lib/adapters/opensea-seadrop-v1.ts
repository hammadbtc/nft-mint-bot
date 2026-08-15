import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import type { MintAdapter, MintPhase, ResolvedMint, SupportedCollection } from "./types";

const SEA_DROP_READ_ABI = [
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
];
const SEA_DROP_MINT_ABI = [
  "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
];
const COLLECTION_ABI = [
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)",
];

type SeaDropConfig = {
  seaDropAddress: string;
  feeRecipient: string;
  publicPhaseName?: string;
  phases?: Array<{ id?: string; name: string; startsAt?: string; endsAt?: string; priceWei?: string; maxPerWallet?: number }>;
  urlMatchers?: Array<{ domain: string; path?: string; pathPrefix?: string }>;
};

function configFor(collection: SupportedCollection): SeaDropConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Supported SeaDrop mint has invalid reviewed configuration"); }
  const config = value as Partial<SeaDropConfig>;
  if (!config.seaDropAddress || !ethers.isAddress(config.seaDropAddress)) throw new Error("SeaDrop address is missing or invalid");
  if (!config.feeRecipient || !ethers.isAddress(config.feeRecipient)) throw new Error("SeaDrop fee recipient is missing or invalid");
  return config as SeaDropConfig;
}

function statusFor(startTime: bigint, endTime: bigint, now: bigint): MintPhase["status"] {
  if (startTime > 0n && now < startTime) return "upcoming";
  if (endTime > 0n && now >= endTime) return "ended";
  return "live";
}

export function publicEligibilityForStats(
  minted: bigint,
  maxPerWallet: number,
  quantity: number,
) {
  if (!maxPerWallet) return { phaseId: "public", status: "unknown" as const, reason: "Public wallet limit is unavailable" };
  if (minted + BigInt(quantity) > BigInt(maxPerWallet)) {
    return { phaseId: "public", status: "ineligible" as const, reason: `Wallet has insufficient room under the ${maxPerWallet} public mint limit` };
  }
  return { phaseId: "public", status: "eligible" as const };
}

async function publicDrop(collection: SupportedCollection, provider: ethers.Provider) {
  const config = configFor(collection);
  const seaDrop = new ethers.Contract(config.seaDropAddress, SEA_DROP_READ_ABI, provider);
  const [drop, latestBlock] = await Promise.all([
    seaDrop.getFunction("getPublicDrop").staticCall(collection.contractAddress),
    provider.getBlock("latest"),
  ]);
  if (!latestBlock) throw new Error("RPC did not return the latest block for phase verification");
  const restrictFeeRecipients = Boolean(drop.restrictFeeRecipients);
  if (restrictFeeRecipients) {
    const recipients: string[] = await seaDrop.getFunction("getAllowedFeeRecipients").staticCall(collection.contractAddress);
    if (!recipients.some((recipient) => recipient.toLowerCase() === config.feeRecipient.toLowerCase())) {
      throw new Error("The reviewed SeaDrop fee recipient is no longer allowed");
    }
  }
  return {
    config,
    mintPrice: BigInt(drop.mintPrice),
    startTime: BigInt(drop.startTime),
    endTime: BigInt(drop.endTime),
    maxPerWallet: Number(drop.maxTotalMintableByWallet),
    restrictFeeRecipients,
    chainTimestamp: BigInt(latestBlock.timestamp),
  };
}

export const openseaSeaDropV1: MintAdapter = {
  key: "opensea-seadrop-v1",
  supportsArming: true,
  canArmPhase: (phaseId) => phaseId === "public",
  recommendedGasLimit: 500_000n,

  async checkEligibility(collection, signerAddress, quantity, provider, phases) {
    const nft = new ethers.Contract(collection.contractAddress, COLLECTION_ABI, provider);
    const [minted, supply, maxSupply] = await nft.getFunction("getMintStats").staticCall(signerAddress);
    const maxPerWallet = phases.find((phase) => phase.id === "public")?.maxPerWallet || 0;
    // Supply is global phase availability, not wallet eligibility. Keep it out
    // of the dashboard eligibility count; buildTransaction rechecks it before
    // signing so a sold-out mint can never be executed.
    void supply;
    void maxSupply;
    return [publicEligibilityForStats(BigInt(minted), maxPerWallet, quantity)];
  },

  async resolve(collection, source): Promise<ResolvedMint> {
    const provider = getProvider(collection.chainId);
    const { config, mintPrice, startTime, endTime, maxPerWallet, chainTimestamp } = await publicDrop(collection, provider);
    const nft = new ethers.Contract(collection.contractAddress, COLLECTION_ABI, provider);
    const [maxSupplyValue, currentSupplyValue] = await Promise.all([
      nft.getFunction("maxSupply").staticCall(),
      nft.getFunction("totalSupply").staticCall(),
    ]);
    const maxSupply = Number(maxSupplyValue);
    const currentSupply = Number(currentSupplyValue);
    const startsAt = startTime > 0n ? new Date(Number(startTime) * 1000).toISOString() : undefined;
    const endsAt = endTime > 0n ? new Date(Number(endTime) * 1000).toISOString() : undefined;
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
      maxSupply,
      currentSupply,
      phases: [{
        id: "public",
        name: config.publicPhaseName || "Public Mint",
        kind: "public",
        status: statusFor(startTime, endTime, chainTimestamp),
        startsAt,
        endsAt,
        priceWei: mintPrice.toString(),
        maxPerWallet,
      }],
      source,
    };
  },

  async buildTransaction(collection, signerAddress, quantity, provider, options) {
    if (options?.phaseId && options.phaseId !== "public") throw new Error("Unsupported SeaDrop phase selected");
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Mint quantity must be a positive integer");
    const { config, mintPrice, startTime, endTime, maxPerWallet, chainTimestamp: now } = await publicDrop(collection, provider);
    if (!options?.allowBeforeStart && startTime > 0n && now < startTime) throw new Error("Public mint has not started");
    if (endTime > 0n && now >= endTime) throw new Error("Public mint has ended");
    const nft = new ethers.Contract(collection.contractAddress, COLLECTION_ABI, provider);
    const [minted, supply, maxSupply] = await nft.getFunction("getMintStats").staticCall(signerAddress);
    if (BigInt(minted) + BigInt(quantity) > BigInt(maxPerWallet)) throw new Error(`Quantity exceeds the ${maxPerWallet} per-wallet public mint limit`);
    if (BigInt(supply) + BigInt(quantity) > BigInt(maxSupply)) throw new Error("Quantity exceeds remaining public supply");
    const iface = new ethers.Interface(SEA_DROP_MINT_ABI);
    return {
      to: config.seaDropAddress,
      data: iface.encodeFunctionData("mintPublic", [collection.contractAddress, config.feeRecipient, ethers.ZeroAddress, quantity]),
      value: mintPrice * BigInt(quantity),
      chainId: collection.chainId,
    };
  },
};

export function encodeSeaDropPublicMint(collectionAddress: string, feeRecipient: string, signerAddress: string, quantity: number) {
  void signerAddress;
  return new ethers.Interface(SEA_DROP_MINT_ABI).encodeFunctionData("mintPublic", [collectionAddress, feeRecipient, ethers.ZeroAddress, quantity]);
}
