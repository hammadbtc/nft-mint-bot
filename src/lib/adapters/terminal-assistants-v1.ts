import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import type { MintAdapter, MintPhaseEligibility, ResolvedMint, SupportedCollection } from "./types";

const READ_ABI = [
  "function MAX_SUPPLY() view returns (uint256)",
  "function MINT_PRICE() view returns (uint256)",
  "function MAX_PER_WALLET() view returns (uint256)",
  "function mintOpen() view returns (bool)",
  "function totalMinted() view returns (uint256)",
  "function supply() view returns (uint256)",
  "function mintedBy(address) view returns (uint256)",
];
const MINT_ABI = ["function mint() payable returns (uint256 id)"];
const SWITCH_CACHE_MS = 100;
const STATE_CACHE_MS = 100;

type TerminalConfig = {
  expectedMaxSupply: number;
  expectedMintPriceWei: string;
  expectedMaxPerWallet: number;
};

type BaseState = {
  config: TerminalConfig;
  blockNumber: number;
  mintOpen: boolean;
  totalMinted: bigint;
  supply: bigint;
};

const stateCache = new WeakMap<object, Map<string, { expiresAt: number; promise: Promise<BaseState> }>>();
const switchCache = new WeakMap<object, Map<string, { expiresAt: number; promise: Promise<boolean> }>>();

function configFor(collection: SupportedCollection): TerminalConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Terminal Assistants has invalid reviewed configuration"); }
  const config = value as Partial<TerminalConfig>;
  if (config.expectedMaxSupply !== 6_666) throw new Error("Terminal Assistants reviewed maximum supply must be 6,666");
  if (config.expectedMintPriceWei !== "1300000000000000") throw new Error("Terminal Assistants reviewed mint price must be 0.0013 ETH");
  if (config.expectedMaxPerWallet !== 5) throw new Error("Terminal Assistants reviewed wallet cap must be five");
  return config as TerminalConfig;
}

async function readBaseState(collection: SupportedCollection, provider: ethers.Provider): Promise<BaseState> {
  const config = configFor(collection);
  const contract = new ethers.Contract(collection.contractAddress, READ_ABI, provider);
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Robinhood RPC did not return a latest block for Terminal Assistants");
  const atBlock = { blockTag: block.number };
  const [maxSupply, mintPrice, maxPerWallet, mintOpen, totalMinted, supply] = await Promise.all([
    contract.getFunction("MAX_SUPPLY").staticCall(atBlock).then(BigInt),
    contract.getFunction("MINT_PRICE").staticCall(atBlock).then(BigInt),
    contract.getFunction("MAX_PER_WALLET").staticCall(atBlock).then(BigInt),
    contract.getFunction("mintOpen").staticCall(atBlock).then(Boolean),
    contract.getFunction("totalMinted").staticCall(atBlock).then(BigInt),
    contract.getFunction("supply").staticCall(atBlock).then(BigInt),
  ]);
  if (maxSupply !== BigInt(config.expectedMaxSupply)) throw new Error("Terminal Assistants on-chain maximum supply changed from 6,666");
  if (mintPrice !== BigInt(config.expectedMintPriceWei)) throw new Error("Terminal Assistants on-chain mint price changed from 0.0013 ETH");
  if (maxPerWallet !== BigInt(config.expectedMaxPerWallet)) throw new Error("Terminal Assistants on-chain wallet cap changed from five");
  if (supply > maxSupply || totalMinted > supply) throw new Error("Terminal Assistants on-chain supply accounting is inconsistent");
  return { config, blockNumber: block.number, mintOpen, totalMinted, supply };
}

async function readState(collection: SupportedCollection, provider: ethers.Provider, signerAddress?: string) {
  let byCollection = stateCache.get(provider);
  if (!byCollection) {
    byCollection = new Map();
    stateCache.set(provider, byCollection);
  }
  const key = collection.contractAddress.toLowerCase();
  let cached = byCollection.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    const promise = readBaseState(collection, provider);
    cached = { expiresAt: Date.now() + STATE_CACHE_MS, promise };
    byCollection.set(key, cached);
    void promise.catch(() => { if (byCollection?.get(key)?.promise === promise) byCollection.delete(key); });
  }
  const contract = new ethers.Contract(collection.contractAddress, READ_ABI, provider);
  const base = await cached.promise;
  const mintedBy = signerAddress
    ? await contract.getFunction("mintedBy").staticCall(signerAddress, { blockTag: base.blockNumber }).then(BigInt)
    : 0n;
  return { ...base, mintedBy };
}

async function isMintOpen(collection: SupportedCollection, provider: ethers.Provider): Promise<boolean> {
  let byCollection = switchCache.get(provider);
  if (!byCollection) {
    byCollection = new Map();
    switchCache.set(provider, byCollection);
  }
  const key = collection.contractAddress.toLowerCase();
  let cached = byCollection.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    const contract = new ethers.Contract(collection.contractAddress, READ_ABI, provider);
    const promise = contract.getFunction("mintOpen").staticCall().then(Boolean);
    cached = { expiresAt: Date.now() + SWITCH_CACHE_MS, promise };
    byCollection.set(key, cached);
    void promise.catch(() => { if (byCollection?.get(key)?.promise === promise) byCollection.delete(key); });
  }
  return cached.promise;
}

async function revalidateMintSnapshot(collection: SupportedCollection, provider: ethers.Provider, signerAddress: string): Promise<void> {
  const contract = new ethers.Contract(collection.contractAddress, READ_ABI, provider);
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Robinhood RPC did not return a latest block for Terminal Assistants");
  const atBlock = { blockTag: block.number };
  const [mintOpen, totalMinted, supply, mintedBy] = await Promise.all([
    contract.getFunction("mintOpen").staticCall(atBlock).then(Boolean),
    contract.getFunction("totalMinted").staticCall(atBlock).then(BigInt),
    contract.getFunction("supply").staticCall(atBlock).then(BigInt),
    contract.getFunction("mintedBy").staticCall(signerAddress, atBlock).then(BigInt),
  ]);
  if (!mintOpen) throw new Error("Terminal Assistants mint has not been opened on-chain");
  if (totalMinted >= supply) throw new Error("Terminal Assistants is sold out");
  if (mintedBy >= 5n) throw new Error("This wallet has reached the five-mint contract cap");
}

function assertMintRequest(collection: SupportedCollection, request: ethers.TransactionRequest): void {
  if (
    String(request.to || "").toLowerCase() !== collection.contractAddress.toLowerCase()
    || String(request.data || "0x").toLowerCase() !== encodeTerminalAssistantsMint().toLowerCase()
    || BigInt(request.value ?? 0) !== 1_300_000_000_000_000n
    || Number(request.chainId) !== collection.chainId
  ) throw new Error("Terminal Assistants prepared transaction does not match reviewed mint intent");
}

function eligibility(status: MintPhaseEligibility["status"], reason?: string): MintPhaseEligibility[] {
  return [{ phaseId: "open", status, reason }];
}

export const terminalAssistantsV1: MintAdapter = {
  key: "terminal-assistants-v1",
  supportsArming: false,

  async pollPhaseReady(collection, phaseId, provider) {
    if (phaseId !== "open") return true;
    return isMintOpen(collection, provider);
  },

  async resolve(collection, source): Promise<ResolvedMint> {
    const state = await readState(collection, getProvider(collection.chainId));
    const soldOut = state.totalMinted >= state.supply;
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
      maxSupply: Number(state.supply),
      currentSupply: Number(state.totalMinted),
      phases: [{
        id: "open",
        name: "Open Mint",
        kind: "public",
        status: soldOut ? "ended" : state.mintOpen ? "live" : "upcoming",
        priceWei: state.config.expectedMintPriceWei,
        maxPerWallet: 1,
        manualOpen: !soldOut && !state.mintOpen,
      }],
      source,
    };
  },

  async checkEligibility(collection, signerAddress, quantity, provider) {
    if (!Number.isSafeInteger(quantity) || quantity !== 1) return eligibility("ineligible", "Terminal Assistants mints exactly one NFT per transaction");
    const state = await readState(collection, provider, signerAddress);
    if (state.totalMinted >= state.supply) return eligibility("ineligible", "Terminal Assistants is sold out");
    if (state.mintedBy >= BigInt(state.config.expectedMaxPerWallet)) return eligibility("ineligible", "This wallet has reached the five-mint contract cap");
    return eligibility("eligible");
  },

  async buildTransaction(collection, signerAddress, quantity, provider, options) {
    if (!Number.isSafeInteger(quantity) || quantity !== 1) throw new Error("Terminal Assistants mints exactly one NFT per transaction");
    if (options?.phaseId !== "open") throw new Error("Unsupported Terminal Assistants phase selected");
    const state = await readState(collection, provider, signerAddress);
    if (!state.mintOpen) throw new Error("Terminal Assistants mint has not been opened on-chain");
    if (state.totalMinted >= state.supply) throw new Error("Terminal Assistants is sold out");
    if (state.mintedBy >= BigInt(state.config.expectedMaxPerWallet)) throw new Error("This wallet has reached the five-mint contract cap");
    return {
      to: collection.contractAddress,
      data: encodeTerminalAssistantsMint(),
      value: BigInt(state.config.expectedMintPriceWei),
      chainId: collection.chainId,
    };
  },

  async revalidateBeforeSigning(collection, signerAddress, quantity, provider, request, options) {
    if (options?.phaseId !== "open" || quantity !== 1) throw new Error("Unsupported Terminal Assistants mint intent");
    assertMintRequest(collection, request);
    await revalidateMintSnapshot(collection, provider, signerAddress);
  },
};

export function encodeTerminalAssistantsMint(): string {
  return new ethers.Interface(MINT_ABI).encodeFunctionData("mint");
}
