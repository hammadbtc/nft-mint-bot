import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import type { MintAdapter, MintPhaseEligibility, ResolvedMint, SupportedCollection } from "./types";

const READ_ABI = [
  "function MAX_SUPPLY() view returns (uint256)",
  "function RESERVE_SUPPLY() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)",
  "function whitelistEnabled() view returns (bool)",
  "function mintClosed() view returns (bool)",
  "function totalMinted() view returns (uint256)",
  "function hasMinted(address) view returns (bool)",
];
const MINT_ABI = ["function mint(bytes32[] proof)"];
const MAX_WHITELIST_BYTES = 10_000_000;
const WHITELIST_CACHE_MS = 60_000;
const STATE_CACHE_MS = 400;

type BullsRunnersConfig = {
  expectedMerkleRoot: string;
  expectedMaxSupply: number;
  expectedReserveSupply: number;
  expectedWhitelistCount: number;
  whitelistUrl: string;
};

type WhitelistPayload = {
  root: string;
  count: number;
  proofs: Record<string, string[]>;
};

let whitelistCache: { expiresAt: number; payload: WhitelistPayload } | null = null;
let whitelistRequest: Promise<WhitelistPayload> | null = null;
const stateCache = new WeakMap<object, Map<string, { expiresAt: number; promise: Promise<BaseState> }>>();

type BaseState = {
  config: BullsRunnersConfig;
  whitelistEnabled: boolean;
  mintClosed: boolean;
  totalMinted: bigint;
  maxSupply: bigint;
};

function configFor(collection: SupportedCollection): BullsRunnersConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Bulls Runners has invalid reviewed configuration"); }
  const config = value as Partial<BullsRunnersConfig>;
  if (!config.expectedMerkleRoot || !ethers.isHexString(config.expectedMerkleRoot, 32)) throw new Error("Bulls Runners reviewed Merkle root is invalid");
  if (config.expectedMaxSupply !== 4_200) throw new Error("Bulls Runners reviewed supply must be 4,200");
  if (config.expectedReserveSupply !== 420) throw new Error("Bulls Runners reviewed reserve must be 420");
  if (config.expectedWhitelistCount !== 4_880) throw new Error("Bulls Runners reviewed whitelist count must be 4,880");
  if (config.whitelistUrl !== "https://bullsrunners.com/whitelist.json") throw new Error("Bulls Runners whitelist source is not the reviewed official URL");
  return config as BullsRunnersConfig;
}

async function readBaseState(collection: SupportedCollection, provider: ethers.Provider): Promise<BaseState> {
  const config = configFor(collection);
  const contract = new ethers.Contract(collection.contractAddress, READ_ABI, provider);
  const [maxSupply, reserveSupply, merkleRoot, whitelistEnabled, mintClosed, totalMinted] = await Promise.all([
    contract.getFunction("MAX_SUPPLY").staticCall().then(BigInt),
    contract.getFunction("RESERVE_SUPPLY").staticCall().then(BigInt),
    contract.getFunction("merkleRoot").staticCall().then(String),
    contract.getFunction("whitelistEnabled").staticCall().then(Boolean),
    contract.getFunction("mintClosed").staticCall().then(Boolean),
    contract.getFunction("totalMinted").staticCall().then(BigInt),
  ]);
  if (maxSupply !== BigInt(config.expectedMaxSupply)) throw new Error("Bulls Runners on-chain maximum supply changed from 4,200");
  if (reserveSupply !== BigInt(config.expectedReserveSupply)) throw new Error("Bulls Runners on-chain reserve changed from 420");
  if (merkleRoot.toLowerCase() !== config.expectedMerkleRoot.toLowerCase()) throw new Error("Bulls Runners on-chain whitelist root changed from the reviewed value");
  if (totalMinted > maxSupply) throw new Error("Bulls Runners on-chain mint accounting is inconsistent");
  return { config, whitelistEnabled, mintClosed, totalMinted, maxSupply };
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
  const [base, hasMinted] = await Promise.all([
    cached.promise,
    signerAddress ? contract.getFunction("hasMinted").staticCall(signerAddress).then(Boolean) : Promise.resolve(false),
  ]);
  return { ...base, hasMinted };
}

function isBytes32(value: unknown): value is string {
  return typeof value === "string" && ethers.isHexString(value, 32);
}

async function fetchWhitelist(config: BullsRunnersConfig): Promise<WhitelistPayload> {
  if (whitelistCache && whitelistCache.expiresAt > Date.now()) return whitelistCache.payload;
  if (whitelistRequest) return whitelistRequest;
  whitelistRequest = (async () => {
    const response = await fetch(config.whitelistUrl, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Bulls Runners whitelist request failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength > MAX_WHITELIST_BYTES) throw new Error("Bulls Runners whitelist response is unexpectedly large");
    const text = await response.text();
    if (text.length > MAX_WHITELIST_BYTES) throw new Error("Bulls Runners whitelist response is unexpectedly large");
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new Error("Bulls Runners whitelist response is invalid JSON"); }
    const candidate = raw as Partial<WhitelistPayload>;
    if (!candidate || !isBytes32(candidate.root) || candidate.root.toLowerCase() !== config.expectedMerkleRoot.toLowerCase()) {
      throw new Error("Bulls Runners whitelist root does not match the reviewed on-chain root");
    }
    if (candidate.count !== config.expectedWhitelistCount || !candidate.proofs || typeof candidate.proofs !== "object" || Array.isArray(candidate.proofs)) {
      throw new Error("Bulls Runners whitelist payload does not match the reviewed list");
    }
    const payload = candidate as WhitelistPayload;
    whitelistCache = { expiresAt: Date.now() + WHITELIST_CACHE_MS, payload };
    return payload;
  })();
  try { return await whitelistRequest; }
  finally { whitelistRequest = null; }
}

async function proofFor(config: BullsRunnersConfig, signerAddress: string): Promise<string[] | null> {
  const payload = await fetchWhitelist(config);
  const leaf = bullsRunnersLeaf(signerAddress);
  const rawProof = payload.proofs[leaf] || payload.proofs[leaf.toLowerCase()];
  if (!Array.isArray(rawProof)) return null;
  if (rawProof.length > 64 || !rawProof.every(isBytes32)) throw new Error("Bulls Runners returned an invalid wallet proof");
  if (!verifyBullsRunnersProof(leaf, rawProof, payload.root)) throw new Error("Bulls Runners wallet proof failed local Merkle verification");
  return rawProof;
}

function unavailable(reason: string): MintPhaseEligibility[] {
  return [
    { phaseId: "whitelist", status: "ineligible", reason },
    { phaseId: "open", status: "ineligible", reason },
  ];
}

export const bullsRunnersV1: MintAdapter = {
  key: "bulls-runners-v1",
  supportsArming: false,

  async resolve(collection, source): Promise<ResolvedMint> {
    const state = await readState(collection, getProvider(collection.chainId));
    const soldOut = state.totalMinted >= state.maxSupply;
    const unavailable = state.mintClosed || soldOut;
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
      maxSupply: Number(state.maxSupply),
      currentSupply: Number(state.totalMinted),
      phases: [
        {
          id: "whitelist",
          name: "Whitelist",
          kind: "allowlist",
          status: unavailable || !state.whitelistEnabled ? "ended" : "live",
          priceWei: "0",
          maxPerWallet: 1,
        },
        {
          id: "open",
          name: "Open Mint",
          kind: "public",
          status: unavailable ? "ended" : state.whitelistEnabled ? "upcoming" : "live",
          priceWei: "0",
          maxPerWallet: 1,
          manualOpen: !unavailable && state.whitelistEnabled,
        },
      ],
      source,
    };
  },

  async checkEligibility(collection, signerAddress, quantity, provider) {
    if (!Number.isSafeInteger(quantity) || quantity !== 1) return unavailable("Bulls Runners allows exactly one mint per wallet");
    const state = await readState(collection, provider, signerAddress);
    if (state.mintClosed) return unavailable("Bulls Runners mint is closed");
    if (state.totalMinted >= state.maxSupply) return unavailable("Bulls Runners is sold out");
    if (state.hasMinted) return unavailable("This wallet has already minted its Bull");
    const publicEligibility: MintPhaseEligibility = { phaseId: "open", status: "eligible" };
    if (!state.whitelistEnabled) {
      return [{ phaseId: "whitelist", status: "ineligible", reason: "Whitelist phase has ended" }, publicEligibility];
    }
    const proof = await proofFor(state.config, signerAddress);
    return [
      proof
        ? { phaseId: "whitelist", status: "eligible" }
        : { phaseId: "whitelist", status: "ineligible", reason: "Wallet is not on the reviewed Bulls Runners whitelist" },
      publicEligibility,
    ];
  },

  async buildTransaction(collection, signerAddress, quantity, provider, options) {
    if (!Number.isSafeInteger(quantity) || quantity !== 1) throw new Error("Bulls Runners allows exactly one mint per wallet");
    if (!options?.phaseId || !["whitelist", "open"].includes(options.phaseId)) throw new Error("Unsupported Bulls Runners phase selected");
    const state = await readState(collection, provider, signerAddress);
    if (state.mintClosed) throw new Error("Bulls Runners mint is closed");
    if (state.totalMinted >= state.maxSupply) throw new Error("Bulls Runners is sold out");
    if (state.hasMinted) throw new Error("This wallet has already minted its Bull");
    let proof: string[];
    if (options.phaseId === "whitelist") {
      if (!state.whitelistEnabled) throw new Error("Bulls Runners whitelist phase has ended");
      proof = await proofFor(state.config, signerAddress) || [];
      if (!proof.length) throw new Error("Wallet is not on the reviewed Bulls Runners whitelist");
    } else {
      if (state.whitelistEnabled) throw new Error("Bulls Runners open mint has not been enabled on-chain");
      proof = [];
    }
    return {
      to: collection.contractAddress,
      data: encodeBullsRunnersMint(proof),
      value: 0n,
      chainId: collection.chainId,
    };
  },
};

export function bullsRunnersLeaf(address: string): string {
  const encodedAddress = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ethers.getAddress(address)]);
  return ethers.keccak256(ethers.concat([ethers.keccak256(encodedAddress)]));
}

export function verifyBullsRunnersProof(leaf: string, proof: string[], expectedRoot: string): boolean {
  if (!isBytes32(leaf) || !isBytes32(expectedRoot) || !proof.every(isBytes32)) return false;
  let hash = leaf;
  for (const sibling of proof) {
    const pair = BigInt(hash) < BigInt(sibling) ? [hash, sibling] : [sibling, hash];
    hash = ethers.keccak256(ethers.concat(pair));
  }
  return hash.toLowerCase() === expectedRoot.toLowerCase();
}

export function encodeBullsRunnersMint(proof: string[]): string {
  return new ethers.Interface(MINT_ABI).encodeFunctionData("mint", [proof]);
}
