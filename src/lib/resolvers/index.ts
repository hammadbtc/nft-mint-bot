import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import { stableHash } from "@/lib/safety";
import type { MintResolverDescriptor, MintResolverInput, MintResolverResult, ResolverEvidence } from "./types";

const VERSION = "resolver-v1";
const SEADROP_V1 = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_V1_CHAINS = new Set([1, 10, 137, 8453, 4663, 42161, 43114, 11155111, 80002, 84532, 421614]);
const SEADROP_READ_ABI = [
  "function getPublicDrop(address) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
  "function getAllowListMerkleRoot(address) view returns (bytes32)",
  "function getSigners(address) view returns (address[])",
  "function getTokenGatedAllowedTokens(address) view returns (address[])",
  "function getAllowedFeeRecipients(address) view returns (address[])",
];

export const mintResolverDescriptors: MintResolverDescriptor[] = [
  { key: "opensea-seadrop-v1", version: VERSION, label: "OpenSea SeaDrop V1", mode: "onchain", support: "qualified", notes: "Public phases can be fully prefetched; gated phases require complete proof/signer manifests." },
  { key: "opensea-seadrop-v2", version: VERSION, label: "OpenSea SeaDrop V2 ERC-1155", mode: "provider-payload", support: "prefill-only", notes: "Requires a current OpenSea API transaction response and phase metadata; no inferred ABI." },
  { key: "scatter", version: VERSION, label: "Scatter", mode: "provider-payload", support: "prefill-only", notes: "Requires a captured Scatter transaction proposal and complete phase export." },
  { key: "launchmynft", version: VERSION, label: "LaunchMyNFT", mode: "onchain", support: "prefill-only", notes: "Bytecode fingerprinting is supported; a full stage manifest is required before certification." },
  { key: "transient", version: VERSION, label: "Transient", mode: "manual-plugin", support: "manual-review", notes: "Creator and mint contracts are separate; supply a versioned provider/contract fixture." },
  { key: "blever-runite", version: VERSION, label: "Blever / Runite", mode: "manual-plugin", support: "manual-review", notes: "No stable public generic interface is trusted; supply a versioned fixture." },
];

function descriptor(key: string): MintResolverDescriptor | undefined {
  return mintResolverDescriptors.find((item) => item.key === key);
}

async function evidenceFor(input: MintResolverInput): Promise<{ provider: ethers.Provider; evidence: ResolverEvidence; code: string }> {
  const provider = getProvider(input.chainId);
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("RPC did not return a hash-pinned latest block");
  const code = await provider.getCode(input.contractAddress, block.number);
  if (code === "0x") throw new Error("Mint contract has no deployed bytecode at the pinned block");
  return {
    provider,
    code,
    evidence: {
      blockNumber: block.number,
      blockHash: block.hash,
      contractCodeHash: ethers.keccak256(code),
      observations: {},
    },
  };
}

function baseResult(input: MintResolverInput, key: string, evidence: ResolverEvidence): MintResolverResult {
  return {
    resolverKey: key,
    resolverVersion: VERSION,
    status: "needs-input",
    platform: key,
    chainId: input.chainId,
    contractAddress: ethers.getAddress(input.contractAddress),
    blockers: [],
    warnings: ["Resolver output is draft-only and cannot bypass definition certification or activation."],
    evidence,
    certificationRequired: true,
  };
}

function iso(seconds: bigint): string | undefined {
  return seconds > 0n ? new Date(Number(seconds) * 1000).toISOString() : undefined;
}

async function resolveSeaDropV1(input: MintResolverInput): Promise<MintResolverResult> {
  if (!SEADROP_V1_CHAINS.has(input.chainId)) throw new Error("SeaDrop V1 has no reviewed deployment for this chain");
  const { provider, evidence } = await evidenceFor(input);
  const routerCode = await provider.getCode(SEADROP_V1, evidence.blockNumber);
  if (routerCode === "0x") throw new Error("Reviewed SeaDrop V1 router is not deployed on this chain at the pinned block");
  const contract = new ethers.Contract(SEADROP_V1, SEADROP_READ_ABI, provider);
  const [publicDrop, root, signers, tokenGates, recipients] = await Promise.all([
    contract.getFunction("getPublicDrop").staticCall(input.contractAddress, { blockTag: evidence.blockNumber }),
    contract.getFunction("getAllowListMerkleRoot").staticCall(input.contractAddress, { blockTag: evidence.blockNumber }),
    contract.getFunction("getSigners").staticCall(input.contractAddress, { blockTag: evidence.blockNumber }),
    contract.getFunction("getTokenGatedAllowedTokens").staticCall(input.contractAddress, { blockTag: evidence.blockNumber }),
    contract.getFunction("getAllowedFeeRecipients").staticCall(input.contractAddress, { blockTag: evidence.blockNumber }),
  ]);
  const publicConfigured = BigInt(publicDrop.startTime) > 0n || BigInt(publicDrop.endTime) > 0n || BigInt(publicDrop.maxTotalMintableByWallet) > 0n;
  const allowListConfigured = String(root).toLowerCase() !== ethers.ZeroHash;
  const signerList = [...signers].map(String);
  const gatedTokens = [...tokenGates].map(String);
  evidence.observations = {
    seaDropAddress: SEADROP_V1,
    seaDropCodeHash: ethers.keccak256(routerCode),
    publicConfigured,
    allowListMerkleRoot: String(root),
    signerCount: signerList.length,
    tokenGatedTokenCount: gatedTokens.length,
    allowedFeeRecipients: [...recipients].map(String),
  };
  const result = baseResult(input, "opensea-seadrop-v1", evidence);
  if (!publicConfigured && !allowListConfigured && !signerList.length && !gatedTokens.length) {
    result.status = "unsupported";
    result.blockers.push("The reviewed SeaDrop router has no configured phases for this contract.");
    return result;
  }
  if (allowListConfigured) result.blockers.push("Provide the complete allowlist leaf schema and wallet proof source; a Merkle root alone is insufficient.");
  if (signerList.length) result.blockers.push("Provide the signed-mint provider contract, message schema, signer policy, and captured fixtures for every signed phase.");
  if (gatedTokens.length) result.blockers.push("Provide every token-gated stage parameter and token-id redemption rule.");
  if (!publicConfigured) result.blockers.push("No public phase is configured; gated phases cannot be inferred safely.");
  if (!input.feeRecipient || !ethers.isAddress(input.feeRecipient)) result.blockers.push("Provide the reviewed fee recipient used for public mint calls.");
  if (!input.name || !input.slug || !input.siteUrl || !input.domains?.length) result.blockers.push("Provide name, slug, canonical mint URL, and exact allowed domains.");
  if (result.blockers.length) return result;

  const feeRecipient = ethers.getAddress(input.feeRecipient!);
  if (Boolean(publicDrop.restrictFeeRecipients) && ![...recipients].some((value) => String(value).toLowerCase() === feeRecipient.toLowerCase())) {
    result.blockers.push("The supplied fee recipient is not in the on-chain allowed fee-recipient set.");
    return result;
  }
  const mintFunction = "mintPublic(address,address,address,uint256)";
  result.draft = {
    name: input.name,
    slug: input.slug,
    contractAddress: ethers.getAddress(input.contractAddress),
    chainId: input.chainId,
    mintMethod: mintFunction,
    mintAbi: [`function ${mintFunction} payable`],
    mintPrice: BigInt(publicDrop.mintPrice).toString(),
    maxPerWallet: Number(publicDrop.maxTotalMintableByWallet),
    adapterKey: "reviewed-call-v1",
    domains: input.domains,
    siteUrl: input.siteUrl,
    adapterConfig: {
      schemaVersion: 1,
      engine: "custom-reviewed-v1",
      phases: [{
        id: "public", name: "Public Mint", kind: "public",
        opening: { mode: "time", ...(iso(BigInt(publicDrop.startTime)) ? { startsAt: iso(BigInt(publicDrop.startTime)) } : {}), ...(iso(BigInt(publicDrop.endTime)) ? { endsAt: iso(BigInt(publicDrop.endTime)) } : {}) },
        unitPriceWei: BigInt(publicDrop.mintPrice).toString(),
        maxPerWallet: Number(publicDrop.maxTotalMintableByWallet),
        eligibility: { strategy: "public" },
        call: {
          target: { source: "reviewed", address: SEADROP_V1 }, function: mintFunction,
          args: [
            { source: "constant", value: ethers.getAddress(input.contractAddress) },
            { source: "constant", value: feeRecipient },
            { source: "constant", value: ethers.ZeroAddress },
            { source: "quantity" },
          ],
          value: { source: "unit-price-times-quantity" },
        },
      }],
    },
  };
  result.status = "resolved";
  return result;
}

function hasSelector(code: string, signature: string): boolean {
  return code.toLowerCase().includes(ethers.id(signature).slice(2, 10).toLowerCase());
}

async function resolveLaunchMyNft(input: MintResolverInput): Promise<MintResolverResult> {
  const { evidence, code } = await evidenceFor(input);
  const fingerprints = {
    mint: hasSelector(code, "mint(uint256,bytes32[])"),
    activeStage: hasSelector(code, "getActiveStageFromTimestamp(uint256)"),
    stageInfo: hasSelector(code, "getStageInfo(uint256)"),
  };
  evidence.observations = { fingerprints };
  const result = baseResult(input, "launchmynft", evidence);
  if (!fingerprints.mint || !fingerprints.activeStage) {
    result.status = "unsupported";
    result.blockers.push("Contract bytecode does not match the reviewed LaunchMyNFT embed interface.");
    return result;
  }
  result.blockers.push("Export every stage, price, wallet/global limit, Merkle root/leaf rule, platform fee and threshold; the active stage alone is not a complete mint definition.");
  result.warnings.push("LaunchMyNFT was fingerprinted from its official embed interface; no transaction recipe was invented from bytecode.");
  return result;
}

async function resolveProviderOrManual(input: MintResolverInput, item: MintResolverDescriptor): Promise<MintResolverResult> {
  const { evidence } = await evidenceFor(input);
  const result = baseResult(input, item.key, evidence);
  evidence.observations = { providerPayloadHash: input.providerPayload ? stableHash(input.providerPayload) : null };
  if (item.mode === "manual-plugin") {
    result.blockers.push(item.notes, "A reviewed plugin descriptor and fixtures are required before any transaction recipe can be generated.");
  } else if (!input.providerPayload) {
    result.blockers.push(item.notes, "Provide a current provider transaction response plus complete phase metadata.");
  } else {
    const envelope = input.providerPayload as { transaction?: { chainId?: unknown; to?: unknown; data?: unknown; value?: unknown; from?: unknown }; phases?: unknown };
    const transaction = envelope?.transaction;
    const chainId = Number(transaction?.chainId);
    const value = String(transaction?.value ?? "");
    if (!transaction || chainId !== input.chainId || typeof transaction.to !== "string" || !ethers.isAddress(transaction.to)
      || typeof transaction.data !== "string" || !ethers.isHexString(transaction.data)
      || !/^\d+$/.test(value)) {
      result.blockers.push("Provider capture must use { transaction: { chainId, to, data, value, from? }, phases } with a matching chain, EVM target, hex calldata, and decimal value.");
      return result;
    }
    evidence.observations = {
      providerPayloadHash: stableHash(input.providerPayload),
      transactionIntentHash: stableHash({ chainId, to: transaction.to.toLowerCase(), data: transaction.data.toLowerCase(), value }),
      target: ethers.getAddress(transaction.to), selector: transaction.data.slice(0, 10).toLowerCase(), value,
      walletBound: typeof transaction.from === "string" && ethers.isAddress(transaction.from),
      phaseMetadataPresent: Array.isArray(envelope.phases) && envelope.phases.length > 0,
    };
    result.blockers.push("Provider payload captured and normalized for review; certify wallet binding, expiry, response authenticity and every phase before registration.");
  }
  return result;
}

export async function inspectMintResolver(input: MintResolverInput): Promise<MintResolverResult> {
  const key = input.platform.toLowerCase();
  const item = descriptor(key);
  if (!item) throw new Error("Unknown launchpad resolver");
  if (key === "opensea-seadrop-v1") return resolveSeaDropV1(input);
  if (key === "launchmynft") return resolveLaunchMyNft(input);
  return resolveProviderOrManual(input, item);
}

export type { MintResolverDescriptor, MintResolverInput, MintResolverResult } from "./types";
