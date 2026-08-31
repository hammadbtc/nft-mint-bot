import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import type { MintAdapter, MintPhaseEligibility, ResolvedMint, SupportedCollection } from "./types";

const READ_ABI = [
  "function totalMinted() view returns (uint256)",
  "function mintOpenedAt() view returns (uint256)",
  "function mintEndedAt() view returns (uint256)",
  "function mintOpen() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const MINT_ABI = ["function claimFree()"];
const TOO_SOON_ERROR = ethers.id("TooSoon()").slice(0, 10).toLowerCase();
const CLAIM_FREE_SELECTOR = ethers.id("claimFree()").slice(0, 10).toLowerCase();

type CookiezConfig = {
  expectedMaxSupply: number;
  expectedFreePerWallet: number;
  expectedMintIntervalSecs: number;
  expectedValueWei: string;
};

function configFor(collection: SupportedCollection): CookiezConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("COOKIEZ has invalid reviewed configuration"); }
  const config = value as Partial<CookiezConfig>;
  if (config.expectedMaxSupply !== 10_000) throw new Error("COOKIEZ reviewed maximum supply must be 10,000");
  if (config.expectedFreePerWallet !== 5) throw new Error("COOKIEZ reviewed free wallet cap must be five");
  if (config.expectedMintIntervalSecs !== 10) throw new Error("COOKIEZ reviewed free interval must be ten seconds");
  if (config.expectedValueWei !== "0") throw new Error("COOKIEZ free claim value must be zero");
  return config as CookiezConfig;
}

async function readState(collection: SupportedCollection, provider: ethers.Provider, signerAddress?: string) {
  const config = configFor(collection);
  const contract = new ethers.Contract(collection.contractAddress, READ_ABI, provider);
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Robinhood RPC did not return a latest block for COOKIEZ");
  const atBlock = { blockTag: block.number };
  const [totalMinted, mintOpenedAt, mintEndedAt, mintOpen, balance] = await Promise.all([
    contract.getFunction("totalMinted").staticCall(atBlock).then(BigInt),
    contract.getFunction("mintOpenedAt").staticCall(atBlock).then(BigInt),
    contract.getFunction("mintEndedAt").staticCall(atBlock).then(BigInt),
    contract.getFunction("mintOpen").staticCall(atBlock).then(Boolean),
    signerAddress
      ? contract.getFunction("balanceOf").staticCall(signerAddress, atBlock).then(BigInt)
      : Promise.resolve(0n),
  ]);
  if (totalMinted > BigInt(config.expectedMaxSupply)) throw new Error("COOKIEZ on-chain supply exceeds the reviewed 10,000 cap");
  return { config, totalMinted, mintOpenedAt, mintEndedAt, mintOpen, balance };
}

function room(state: Awaited<ReturnType<typeof readState>>): number {
  const supplyRoom = BigInt(state.config.expectedMaxSupply) - state.totalMinted;
  // The contract does not expose its free-claim counter. Counting currently
  // held BAKERS is deliberately conservative: transfers or paid mints can
  // only reduce automation, never bypass the five-free contract cap.
  const walletRoom = BigInt(state.config.expectedFreePerWallet) - state.balance;
  return Number(walletRoom < supplyRoom ? walletRoom : supplyRoom);
}

function eligibility(status: MintPhaseEligibility["status"], reason?: string): MintPhaseEligibility[] {
  return [{ phaseId: "free", status, reason }];
}

function assertRequest(collection: SupportedCollection, request: ethers.TransactionRequest): void {
  if (
    String(request.to || "").toLowerCase() !== collection.contractAddress.toLowerCase()
    || String(request.data || "0x").toLowerCase() !== encodeCookiezFreeClaim().toLowerCase()
    || BigInt(request.value ?? 0) !== 0n
    || Number(request.chainId) !== collection.chainId
  ) throw new Error("COOKIEZ prepared transaction does not match the reviewed free-claim intent");
}

export const cookiezFreeV1: MintAdapter = {
  key: "cookiez-free-v1",
  suppressFailureAlerts: true,
  supportsArming: false,
  recommendedGasLimit: 240_000n,

  simulationRetryAt(error, nowMs = Date.now()) {
    return cookiezSimulationRetryAt(error, nowMs);
  },

  async pollPhaseReady(collection, phaseId, provider) {
    if (phaseId !== "free") return false;
    const state = await readState(collection, provider);
    return state.mintOpen && state.mintEndedAt === 0n && state.totalMinted < BigInt(state.config.expectedMaxSupply);
  },

  async remainingTransactions(collection, phaseId, signerAddress, provider) {
    if (phaseId !== "free") return 0;
    const state = await readState(collection, provider, signerAddress);
    return state.mintOpen ? Math.max(0, room(state)) : 0;
  },

  async resolve(collection, source): Promise<ResolvedMint> {
    const state = await readState(collection, getProvider(collection.chainId));
    const soldOut = state.totalMinted >= BigInt(state.config.expectedMaxSupply) || state.mintEndedAt > 0n;
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
      maxSupply: state.config.expectedMaxSupply,
      currentSupply: Number(state.totalMinted),
      phases: [{
        id: "free",
        name: "Free BAKER Claim",
        kind: "public",
        status: soldOut ? "ended" : state.mintOpen ? "live" : "upcoming",
        priceWei: "0",
        maxPerWallet: 5,
        manualOpen: !soldOut && !state.mintOpen,
      }],
      execution: { onePerTransaction: true, maxPreparedTransactions: 5 },
      source,
    };
  },

  async checkEligibility(collection, signerAddress, quantity, provider) {
    if (quantity !== 1) return eligibility("ineligible", "COOKIEZ free claims mint exactly one BAKER per transaction");
    const state = await readState(collection, provider, signerAddress);
    if (state.totalMinted >= BigInt(state.config.expectedMaxSupply) || state.mintEndedAt > 0n) return eligibility("ineligible", "COOKIEZ is sold out");
    if (room(state) <= 0) return eligibility("ineligible", "This wallet has no conservative free-claim capacity remaining");
    return eligibility("eligible");
  },

  async buildTransaction(collection, signerAddress, quantity, provider, options) {
    if (quantity !== 1 || options?.phaseId !== "free") throw new Error("Unsupported COOKIEZ free-claim intent");
    const state = await readState(collection, provider, signerAddress);
    if (!state.mintOpen) throw new Error("COOKIEZ free mint is not open");
    if (room(state) <= 0) throw new Error("This wallet has no conservative free-claim capacity remaining");
    return { to: collection.contractAddress, data: encodeCookiezFreeClaim(), value: 0n, chainId: collection.chainId };
  },

  async revalidateBeforeSigning(collection, signerAddress, quantity, provider, request, options) {
    if (quantity !== 1 || options?.phaseId !== "free") throw new Error("Unsupported COOKIEZ free-claim intent");
    assertRequest(collection, request);
    const state = await readState(collection, provider, signerAddress);
    if (!state.mintOpen || state.mintEndedAt > 0n) throw new Error("COOKIEZ free mint is not open");
    if (room(state) <= 0) throw new Error("This wallet has no conservative free-claim capacity remaining");
  },
};

export function encodeCookiezFreeClaim(): string {
  return new ethers.Interface(MINT_ABI).encodeFunctionData("claimFree");
}

export function cookiezSimulationRetryAt(error: unknown, nowMs = Date.now()): string | null {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5 || value == null || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "string") { messages.push(value.toLowerCase()); return; }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    [record.data, record.message, record.shortMessage, record.reason, record.cause, record.error, record.info, record.transaction]
      .forEach((item) => visit(item, depth + 1));
  };
  visit(error);
  const exactTooSoon = messages.some((message) => message.includes(TOO_SOON_ERROR));
  // Robinhood RPC occasionally strips custom-error revert data. Accept that
  // narrow transport failure only when the error still identifies the exact
  // reviewed claimFree() calldata; arbitrary missing-data reverts fail closed.
  const strippedClaimRevert = messages.some((message) => message.includes("missing revert data"))
    && messages.some((message) => message.includes(CLAIM_FREE_SELECTOR));
  // One global free claim is currently released every ten seconds. Poll once
  // per second so the bot stays responsive without hammering the RPC.
  return exactTooSoon || strippedClaimRevert ? new Date(nowMs + 1_000).toISOString() : null;
}
