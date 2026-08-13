import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import type { MintAdapter, MintPhase, ResolvedMint, SupportedCollection } from "./types";

const MINTER_READ_ABI = [
  "function MINT_PRICE() view returns (uint256)",
  "function MAX_PER_TX() view returns (uint256)",
  "function collection() view returns (address)",
  "function saleStartTime() view returns (uint256)",
  "function remaining() view returns (uint256)",
  "function distributed() view returns (uint256)",
  "function inventorySize() view returns (uint256)",
  "function inventoryReady() view returns (bool)",
  "function transferPolicyAllowsSale(address to) view returns (bool)",
];
const MINT_ABI = ["function mint(uint256 quantity) payable"];
const COLLECTION_ABI = [
  "function totalSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
];

type SquiggleConfig = {
  mintContract: string;
  transferPolicy: string;
  tokenContract: string;
  expectedPriceWei: string;
  expectedMaxPerTransaction: number;
  expectedInventory: number;
  urlMatchers?: Array<{ domain: string; path: string }>;
  contractAliases?: string[];
};

function configFor(collection: SupportedCollection): SquiggleConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Squiggle Wuiggle has invalid reviewed configuration"); }
  const config = value as Partial<SquiggleConfig>;
  for (const [label, address] of [
    ["mint contract", config.mintContract],
    ["transfer policy", config.transferPolicy],
    ["token contract", config.tokenContract],
  ] as const) {
    if (!address || !ethers.isAddress(address)) throw new Error(`Squiggle Wuiggle ${label} is missing or invalid`);
  }
  if (!config.expectedPriceWei || !/^\d+$/.test(config.expectedPriceWei)) throw new Error("Squiggle Wuiggle reviewed price is invalid");
  if (!Number.isSafeInteger(config.expectedMaxPerTransaction) || config.expectedMaxPerTransaction! < 1) throw new Error("Squiggle Wuiggle reviewed transaction limit is invalid");
  if (!Number.isSafeInteger(config.expectedInventory) || config.expectedInventory! < 1) throw new Error("Squiggle Wuiggle reviewed inventory is invalid");
  return config as SquiggleConfig;
}

function phaseStatus(startTime: bigint, remaining: bigint, chainTimestamp: bigint): MintPhase["status"] {
  if (remaining === 0n || startTime === 0n) return "ended";
  return chainTimestamp < startTime ? "upcoming" : "live";
}

async function readState(collection: SupportedCollection, provider: ethers.Provider) {
  const config = configFor(collection);
  const minter = new ethers.Contract(config.mintContract, MINTER_READ_ABI, provider);
  const nft = new ethers.Contract(collection.contractAddress, COLLECTION_ABI, provider);
  const [price, maxPerTransaction, linkedCollection, startTime, remaining, distributed, inventorySize, totalSupply, maxSupply, latestBlock] = await Promise.all([
    minter.getFunction("MINT_PRICE").staticCall().then(BigInt),
    minter.getFunction("MAX_PER_TX").staticCall().then(BigInt),
    minter.getFunction("collection").staticCall().then(String),
    minter.getFunction("saleStartTime").staticCall().then(BigInt),
    minter.getFunction("remaining").staticCall().then(BigInt),
    minter.getFunction("distributed").staticCall().then(BigInt),
    minter.getFunction("inventorySize").staticCall().then(BigInt),
    nft.getFunction("totalSupply").staticCall().then(BigInt),
    nft.getFunction("MAX_SUPPLY").staticCall().then(BigInt),
    provider.getBlock("latest"),
  ]);
  if (!latestBlock) throw new Error("RPC did not return the latest block for Squiggle Wuiggle");
  if (linkedCollection.toLowerCase() !== collection.contractAddress.toLowerCase()) throw new Error("Squiggle Wuiggle minter is linked to an unexpected collection");
  if (price !== BigInt(config.expectedPriceWei)) throw new Error("Squiggle Wuiggle on-chain price changed from the reviewed value");
  if (maxPerTransaction !== BigInt(config.expectedMaxPerTransaction)) throw new Error("Squiggle Wuiggle transaction limit changed from the reviewed value");
  if (inventorySize !== BigInt(config.expectedInventory)) throw new Error("Squiggle Wuiggle inventory changed from the reviewed value");
  if (totalSupply !== maxSupply || maxSupply !== 10_000n) throw new Error("Squiggle Wuiggle fixed collection supply is no longer the reviewed 10,000");
  if (distributed + remaining !== inventorySize) throw new Error("Squiggle Wuiggle inventory accounting is inconsistent");
  return {
    config,
    minter,
    price,
    maxPerTransaction,
    startTime,
    remaining,
    distributed,
    inventorySize,
    chainTimestamp: BigInt(latestBlock.timestamp),
  };
}

export const squiggleWuiggleV1: MintAdapter = {
  key: "squiggle-wuiggle-v1",
  supportsArming: true,
  // The pre-open call intentionally reverts. This conservative ceiling covers
  // two ERC-721 safe transfers; exact estimation replaces it after opening.
  recommendedGasLimit: 600_000n,

  async resolve(collection, source): Promise<ResolvedMint> {
    const provider = getProvider(collection.chainId);
    const state = await readState(collection, provider);
    const startsAt = state.startTime > 0n ? new Date(Number(state.startTime) * 1_000).toISOString() : undefined;
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
      maxSupply: Number(state.inventorySize),
      currentSupply: Number(state.distributed),
      phases: [{
        id: "public-fcfs",
        name: "Public FCFS",
        status: phaseStatus(state.startTime, state.remaining, state.chainTimestamp),
        startsAt,
        priceWei: state.price.toString(),
        maxPerWallet: Number(state.maxPerTransaction),
      }],
      source,
    };
  },

  async buildTransaction(collection, signerAddress, quantity, provider, options) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Mint quantity must be a positive integer");
    const state = await readState(collection, provider);
    if (BigInt(quantity) > state.maxPerTransaction) throw new Error(`Squiggle Wuiggle allows at most ${state.maxPerTransaction} per transaction`);
    if (BigInt(quantity) > state.remaining) throw new Error("Quantity exceeds remaining Squiggle Wuiggle inventory");
    if (state.startTime === 0n) throw new Error("Squiggle Wuiggle sale is closed");
    if (!options?.allowBeforeStart && state.chainTimestamp < state.startTime) throw new Error("Squiggle Wuiggle public mint has not started");
    const [inventoryReady, policyAllowsSale] = await Promise.all([
      state.minter.getFunction("inventoryReady").staticCall().then(Boolean),
      state.minter.getFunction("transferPolicyAllowsSale").staticCall(signerAddress).then(Boolean),
    ]);
    if (!inventoryReady) throw new Error("Squiggle Wuiggle mint inventory is not ready");
    if (!policyAllowsSale) throw new Error("Squiggle Wuiggle transfer policy rejects the selected wallet");
    return {
      to: state.config.mintContract,
      data: encodeSquiggleWuiggleMint(quantity),
      value: state.price * BigInt(quantity),
      chainId: collection.chainId,
    };
  },
};

export function encodeSquiggleWuiggleMint(quantity: number): string {
  return new ethers.Interface(MINT_ABI).encodeFunctionData("mint", [quantity]);
}
