import { ethers } from "ethers";
import { getProvider } from "@/lib/chains";
import { openSeaApi, withOpenSeaApiForSigner } from "@/lib/opensea-auth";
import { openseaSeaDropV1 } from "./opensea-seadrop-v1";
import type { MintAdapter, MintPhase, MintPhaseEligibility, ResolvedMint, SupportedCollection } from "./types";

const SIGNED_MINT_ABI = [
  "function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable",
];

export type ReviewedOpenSeaStage = {
  id: string;
  name: string;
  kind: "signed" | "public";
  stageType: string;
  startsAt: string;
  endsAt: string;
  priceWei: string;
  maxPerWallet: number;
  dropStageIndex?: number;
  maxTokenSupplyForStage?: number;
  feeBps?: number;
  restrictFeeRecipients?: boolean;
};

export type SignedSeaDropConfig = {
  seaDropAddress: string;
  feeRecipient: string;
  openSeaSlug: string;
  stages: ReviewedOpenSeaStage[];
};

type ApiStage = {
  uuid: string;
  stageType: string;
  label?: string;
  price?: string;
  startTime: string;
  endTime: string;
  maxPerWallet: string;
};

type ApiDrop = {
  collectionSlug: string;
  chain: string;
  contractAddress: string;
  dropType: string;
  stages: ApiStage[];
};

type ApiEligibilityStage = {
  stageUuid: string;
  isEligible: boolean;
  price?: string;
  maxTotalMintableByWallet?: string;
};

export function mapSignedStageEligibility(
  stages: ReviewedOpenSeaStage[],
  apiStages: ApiStage[],
  eligibilityStages: ApiEligibilityStage[],
  quantity: number,
): MintPhaseEligibility[] {
  const normalizeUuid = (value: string | undefined) => (value || "").toLowerCase().replace(/[^a-f0-9]/g, "");
  const apiUuids = new Set(apiStages.map((stage) => normalizeUuid(stage.uuid)).filter(Boolean));
  const unmatched = eligibilityStages.filter((item) => !apiUuids.has(normalizeUuid(item.stageUuid)));
  const unmatchedEligible = unmatched.filter((item) => item.isEligible);
  const mappingCode = unmatchedEligible.map((item) => normalizeUuid(item.stageUuid).slice(0, 8)).filter(Boolean).join(",");
  return stages.filter((stage) => stage.kind === "signed").map((stage) => {
    const apiStage = matchApiStage(stage, apiStages);
    const expectedUuid = normalizeUuid(apiStage?.uuid);
    const result = eligibilityStages.find((item) => normalizeUuid(item.stageUuid) === expectedUuid);
    // The authenticated OpenSea endpoint returns records for stages the wallet
    // can claim and may omit non-matching allowlists. Omission is safe to treat
    // as ineligible: execution still requires a fresh wallet-bound signature.
    if (!result && unmatchedEligible.length) return {
      phaseId: stage.id,
      status: "unknown",
      reason: `OpenSea returned an unmapped eligible signed stage (${mappingCode || "unknown"})`,
    };
    if (!result) return { phaseId: stage.id, status: "ineligible", reason: `Wallet is not eligible for ${stage.name}` };
    if (!result.isEligible) return { phaseId: stage.id, status: "ineligible", reason: `Wallet is not eligible for ${stage.name}` };
    if (result.price != null && BigInt(result.price) !== BigInt(stage.priceWei)) {
      return { phaseId: stage.id, status: "unknown", reason: `${stage.name} wallet price differs from the reviewed price` };
    }
    const walletLimit = result.maxTotalMintableByWallet == null ? stage.maxPerWallet : Number(result.maxTotalMintableByWallet);
    if (!Number.isSafeInteger(walletLimit) || walletLimit < quantity) {
      return { phaseId: stage.id, status: "ineligible", reason: `Wallet has insufficient room under its ${stage.name} mint limit` };
    }
    return { phaseId: stage.id, status: "eligible" };
  });
}

type TimedPromise<T> = { expiresAt: number; value: Promise<T> };
const dropCache = new Map<string, TimedPromise<unknown>>();
const eligibilityCache = new Map<string, TimedPromise<MintPhaseEligibility[]>>();

function cachedPromise<T>(cache: Map<string, TimedPromise<T>>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = load();
  const entry = { expiresAt: Date.now() + ttlMs, value };
  cache.set(key, entry);
  void value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return value;
}

function configFor(collection: SupportedCollection): SignedSeaDropConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Supported signed SeaDrop mint has invalid reviewed configuration"); }
  const config = value as Partial<SignedSeaDropConfig>;
  if (!config.seaDropAddress || !ethers.isAddress(config.seaDropAddress)) throw new Error("SeaDrop address is missing or invalid");
  if (!config.feeRecipient || !ethers.isAddress(config.feeRecipient)) throw new Error("SeaDrop fee recipient is missing or invalid");
  if (!config.openSeaSlug || !config.stages?.length) throw new Error("OpenSea signed-drop stages are missing");
  if (new Set(config.stages.map((stage) => stage.id)).size !== config.stages.length) throw new Error("Reviewed OpenSea stage identifiers must be unique");
  for (const stage of config.stages) {
    if (!stage.id || !stage.name || !["signed", "public"].includes(stage.kind)) throw new Error("Reviewed OpenSea stage is invalid");
    if (!Number.isFinite(Date.parse(stage.startsAt)) || !Number.isFinite(Date.parse(stage.endsAt))) throw new Error("Reviewed OpenSea stage time is invalid");
    if (Date.parse(stage.startsAt) >= Date.parse(stage.endsAt)) throw new Error("Reviewed OpenSea stage window is invalid");
    if (!/^\d+$/.test(stage.priceWei) || !Number.isSafeInteger(stage.maxPerWallet) || stage.maxPerWallet < 1) throw new Error("Reviewed OpenSea stage limits are invalid");
    if (stage.kind === "signed" && (!Number.isSafeInteger(stage.dropStageIndex) || stage.dropStageIndex! < 0)) throw new Error("Reviewed signed stage index is invalid");
    if (stage.kind === "signed" && (!Number.isSafeInteger(stage.maxTokenSupplyForStage) || stage.maxTokenSupplyForStage! < 1)) throw new Error("Reviewed signed stage supply is invalid");
    if (stage.kind === "signed" && (!Number.isSafeInteger(stage.feeBps) || stage.feeBps! < 0 || stage.feeBps! > 10_000)) throw new Error("Reviewed signed stage fee is invalid");
  }
  if (config.stages.filter((stage) => stage.kind === "public").length !== 1) throw new Error("Reviewed OpenSea drop must have one public stage");
  return config as SignedSeaDropConfig;
}

function phaseStatus(startsAt: string, endsAt: string, nowMs: number): MintPhase["status"] {
  if (nowMs < Date.parse(startsAt)) return "upcoming";
  if (nowMs >= Date.parse(endsAt)) return "ended";
  return "live";
}

function normalizeStageType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function matchApiStage(reviewed: ReviewedOpenSeaStage, apiStages: ApiStage[]): ApiStage | undefined {
  return apiStages.find((stage) =>
    normalizeStageType(stage.stageType) === normalizeStageType(reviewed.stageType)
    && sameInstant(stage.startTime, reviewed.startsAt)
    && sameInstant(stage.endTime, reviewed.endsAt)
    && (!stage.label || stage.label === reviewed.name),
  );
}

function validateApiDrop(collection: SupportedCollection, config: SignedSeaDropConfig, raw: unknown): ApiDrop {
  const drop = raw as Partial<ApiDrop>;
  if (drop.collectionSlug !== config.openSeaSlug) throw new Error("OpenSea returned a different drop slug");
  if (drop.chain !== "robinhood") throw new Error("OpenSea returned the signed drop on a different chain");
  if (!drop.dropType || !normalizeStageType(drop.dropType).includes("seadrop")) throw new Error("OpenSea returned a different drop protocol");
  if (!drop.contractAddress || drop.contractAddress.toLowerCase() !== collection.contractAddress.toLowerCase()) throw new Error("OpenSea returned a different drop contract");
  if (!Array.isArray(drop.stages)) throw new Error("OpenSea did not return signed-drop stages");
  for (const reviewed of config.stages) {
    const current = matchApiStage(reviewed, drop.stages);
    if (!current) throw new Error(`${reviewed.name} no longer matches the reviewed OpenSea stage`);
    if (current.price != null && BigInt(current.price) !== BigInt(reviewed.priceWei)) throw new Error(`${reviewed.name} price changed on OpenSea`);
    if (BigInt(current.maxPerWallet) !== BigInt(reviewed.maxPerWallet)) throw new Error(`${reviewed.name} wallet limit changed on OpenSea`);
  }
  return drop as ApiDrop;
}

async function apiEligibility(
  collection: SupportedCollection,
  config: SignedSeaDropConfig,
  signer: ethers.Signer,
  quantity: number,
): Promise<MintPhaseEligibility[]> {
  const signerAddress = (await signer.getAddress()).toLowerCase();
  const cacheKey = `${config.openSeaSlug}:${signerAddress}:${quantity}`;
  return cachedPromise(eligibilityCache, cacheKey, 15_000, async () => {
  const [dropRaw, eligibilityRaw] = await Promise.all([
    cachedPromise(dropCache, config.openSeaSlug, 60_000, () => openSeaApi().then((api) => api.getDrop(config.openSeaSlug))),
    withOpenSeaApiForSigner(signer, (api) => api.walletAuth.getDropEligibility(config.openSeaSlug)),
  ]);
  const drop = validateApiDrop(collection, config, dropRaw);
  const eligibility = eligibilityRaw as unknown as { stages?: ApiEligibilityStage[] };
  if (!Array.isArray(eligibility.stages)) throw new Error("OpenSea did not return wallet stage eligibility");

  return mapSignedStageEligibility(config.stages, drop.stages, eligibility.stages, quantity);
  });
}

export function validateOpenSeaSignedTransaction(
  collection: SupportedCollection,
  config: SignedSeaDropConfig,
  stage: ReviewedOpenSeaStage,
  signerAddress: string,
  quantity: number,
  raw: unknown,
): ethers.TransactionRequest {
  const response = raw as { to?: string; data?: string; value?: string; chain?: string };
  if (response.chain !== "robinhood") throw new Error("OpenSea built the mint on a different chain");
  if (!response.to || response.to.toLowerCase() !== config.seaDropAddress.toLowerCase()) throw new Error("OpenSea returned an unexpected mint target");
  if (!response.data || !ethers.isHexString(response.data)) throw new Error("OpenSea returned invalid signed mint calldata");
  const value = BigInt(response.value || "0");
  const iface = new ethers.Interface(SIGNED_MINT_ABI);
  let decoded: ethers.Result;
  try { decoded = iface.decodeFunctionData("mintSigned", response.data); }
  catch { throw new Error("OpenSea did not return reviewed SeaDrop signed-mint calldata"); }
  const [nftContract, feeRecipient, minterIfNotPayer, decodedQuantity, params, , signature] = decoded;
  if (String(nftContract).toLowerCase() !== collection.contractAddress.toLowerCase()) throw new Error("OpenSea signed mint targets a different NFT contract");
  if (String(feeRecipient).toLowerCase() !== config.feeRecipient.toLowerCase()) throw new Error("OpenSea signed mint uses an unexpected fee recipient");
  const recipient = String(minterIfNotPayer).toLowerCase();
  if (recipient !== ethers.ZeroAddress.toLowerCase() && recipient !== signerAddress.toLowerCase()) throw new Error("OpenSea signed mint would send the NFT to another wallet");
  if (BigInt(decodedQuantity) !== BigInt(quantity)) throw new Error("OpenSea signed mint quantity does not match the job");
  if (BigInt(params.mintPrice) !== BigInt(stage.priceWei)) throw new Error("OpenSea signed mint price changed");
  if (BigInt(params.dropStageIndex) !== BigInt(stage.dropStageIndex!)) throw new Error("OpenSea signed mint stage changed");
  if (BigInt(params.startTime) !== BigInt(Math.floor(Date.parse(stage.startsAt) / 1000))) throw new Error("OpenSea signed mint start time changed");
  if (BigInt(params.endTime) !== BigInt(Math.floor(Date.parse(stage.endsAt) / 1000))) throw new Error("OpenSea signed mint end time changed");
  if (BigInt(params.maxTotalMintableByWallet) > BigInt(stage.maxPerWallet)) throw new Error("OpenSea signed mint wallet cap exceeds the reviewed limit");
  if (BigInt(params.maxTokenSupplyForStage) !== BigInt(stage.maxTokenSupplyForStage!)) throw new Error("OpenSea signed mint stage supply changed");
  if (BigInt(params.feeBps) !== BigInt(stage.feeBps!)) throw new Error("OpenSea signed mint fee changed");
  if (Boolean(params.restrictFeeRecipients) !== Boolean(stage.restrictFeeRecipients)) throw new Error("OpenSea signed mint fee-recipient restriction changed");
  if (value !== BigInt(params.mintPrice) * BigInt(quantity)) throw new Error("OpenSea signed mint payment is not exact");
  if (typeof signature !== "string" || !ethers.isHexString(signature) || signature === "0x") throw new Error("OpenSea signed mint signature is missing");
  return { to: response.to, data: response.data, value, chainId: collection.chainId };
}

export const openseaSignedSeaDropV1: MintAdapter = {
  key: "opensea-signed-seadrop-v1",
  supportsArming: true,
  requiresSignerForEligibility: true,
  canArmPhase: (phaseId) => phaseId === "public",
  recommendedGasLimit: 500_000n,

  async resolve(collection, source): Promise<ResolvedMint> {
    const config = configFor(collection);
    const publicResolved = await openseaSeaDropV1.resolve(collection, source);
    const provider = getProvider(collection.chainId);
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("RPC did not return the latest block for signed-stage verification");
    const publicPhase = publicResolved.phases[0];
    const phases = config.stages.map((stage): MintPhase => stage.kind === "public" ? {
      ...publicPhase,
      id: stage.id,
      name: stage.name,
    } : {
      id: stage.id,
      name: stage.name,
      kind: "signed",
      status: phaseStatus(stage.startsAt, stage.endsAt, Number(latest.timestamp) * 1000),
      startsAt: stage.startsAt,
      endsAt: stage.endsAt,
      priceWei: stage.priceWei,
      maxPerWallet: stage.maxPerWallet,
    });
    const reviewedPublic = config.stages.find((stage) => stage.kind === "public")!;
    if (publicPhase.startsAt !== reviewedPublic.startsAt || publicPhase.endsAt !== reviewedPublic.endsAt) throw new Error("Public SeaDrop schedule changed from the reviewed OpenSea stage");
    if (publicPhase.priceWei !== reviewedPublic.priceWei || publicPhase.maxPerWallet !== reviewedPublic.maxPerWallet) throw new Error("Public SeaDrop terms changed from the reviewed OpenSea stage");
    return { ...publicResolved, adapterKey: collection.adapterKey, phases, source };
  },

  async checkEligibility(collection, signerAddress, quantity, provider, phases, context) {
    const config = configFor(collection);
    const publicResults = await openseaSeaDropV1.checkEligibility!(collection, signerAddress, quantity, provider, phases);
    let signedResults: MintPhaseEligibility[];
    if (!context?.signer) {
      signedResults = config.stages.filter((stage) => stage.kind === "signed").map((stage) => ({
        phaseId: stage.id,
        status: "unknown",
        reason: "Wallet signing is unavailable for OpenSea eligibility",
      }));
    } else {
      try {
        signedResults = await apiEligibility(collection, config, context.signer, quantity);
      } catch (error) {
        const reason = isOpenSeaEligibilityUnavailable(error)
          ? "OpenSea signed-stage eligibility is temporarily unavailable — retrying shortly"
          : error instanceof Error ? error.message : "OpenSea signed-stage eligibility could not be verified";
        signedResults = config.stages.filter((stage) => stage.kind === "signed").map((stage) => ({
          phaseId: stage.id,
          status: "unknown",
          reason,
        }));
      }
    }
    return [...signedResults, ...publicResults];
  },

  async buildTransaction(collection, signerAddress, quantity, provider, options) {
    const config = configFor(collection);
    const phaseId = options?.phaseId || "public";
    const stage = config.stages.find((item) => item.id === phaseId);
    if (!stage) throw new Error("Unsupported OpenSea drop phase selected");
    if (stage.kind === "public") return openseaSeaDropV1.buildTransaction!(collection, signerAddress, quantity, provider, options);
    if (options?.allowBeforeStart) throw new Error("Signed SeaDrop payloads are fetched just in time and cannot be armed early");
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("RPC did not return the latest block for signed-stage execution");
    const now = Number(latest.timestamp) * 1000;
    if (now < Date.parse(stage.startsAt)) throw new Error(`${stage.name} has not started`);
    if (now >= Date.parse(stage.endsAt)) throw new Error(`${stage.name} has ended`);
    const response = await (await openSeaApi()).buildDropMintTransaction(config.openSeaSlug, { minter: signerAddress, quantity });
    return validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, quantity, response);
  },
};

function isOpenSeaEligibilityUnavailable(error: unknown): boolean {
  return error instanceof Error && /429|rate limit|too many requests|temporar|timeout|fetch failed/i.test(error.message);
}
