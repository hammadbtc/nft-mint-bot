import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  applyPayloadEligibility,
  eligibilityPhaseFromTransaction,
  mapSignedStageEligibility,
  openSeaChainForChainId,
  openseaSignedSeaDropV1,
  validateOpenSeaSignedTransaction,
  type ReviewedOpenSeaStage,
  type SignedSeaDropConfig,
} from "../src/lib/adapters/opensea-signed-seadrop-v1";
import { isOpenSeaInvalidApiKeyError } from "../src/lib/opensea-auth";

const collectionAddress = "0x14A247E9e3aCcBC941A705C984a49E291468bC29";
const seaDropAddress = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const feeRecipient = "0x0000a26b00c1F0DF003000390027140000fAa719";
const signerAddress = "0x1111111111111111111111111111111111111111";
const mintAbi = [
  "function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable",
];
const stage: ReviewedOpenSeaStage = {
  id: "fcfs", name: "FCFs", kind: "signed", stageType: "signed_presale",
  startsAt: "2026-08-13T17:30:00.000Z", endsAt: "2026-08-13T19:30:00.000Z",
  priceWei: "0", maxPerWallet: 1, dropStageIndex: 2, maxTokenSupplyForStage: 4500,
  feeBps: 1000, restrictFeeRecipients: true,
};
const config: SignedSeaDropConfig = {
  seaDropAddress, feeRecipient, openSeaSlug: "hoodbirdss", stages: [stage, {
    id: "public", name: "Public stage", kind: "public", stageType: "public_sale",
    startsAt: "2026-08-13T19:30:00.000Z", endsAt: "2026-08-15T21:30:00.000Z",
    priceWei: "1000000000000000", maxPerWallet: 1,
  }],
};
const collection = {
  id: "a82f9217-2303-4a2c-a536-8acf067afda4", name: "HoodBirds", contractAddress: collectionAddress,
  chainId: 4663, mintMethod: "mintSigned", mintAbi: JSON.stringify(mintAbi), mintPrice: "0",
  maxPerWallet: 1, maxSupply: 4500, active: true, defaultGasLimit: null, defaultMaxFeePerGas: null,
  defaultMaxPriorityFeePerGas: null, defaultUseFlashbots: false, fcfsEnabled: false, fcfsMintOpenSignature: null,
  paymentToken: null, safetyCheck: true, slug: "hoodbirdss", adapterKey: "opensea-signed-seadrop-v1",
  domains: '["opensea.io"]', siteUrl: "https://opensea.io/collection/hoodbirdss/overview", imageUrl: null,
  adapterConfig: JSON.stringify(config), verified: true, createdAt: new Date().toISOString(),
};

test("OpenSea signed drops bind reviewed chain IDs to exact API chain identifiers", () => {
  assert.equal(openSeaChainForChainId(1), "ethereum");
  assert.equal(openSeaChainForChainId(4663), "robinhood");
  assert.throws(() => openSeaChainForChainId(8453), /unsupported on chain 8453/);
});

test("dashboard eligibility retains authenticated per-stage OpenSea checks", () => {
  assert.equal(openseaSignedSeaDropV1.requiresSignerForEligibility, true);
});

test("OpenSea invalid or expired API-key responses are recognized for automatic failover", () => {
  assert.equal(isOpenSeaInvalidApiKeyError(new Error("Server Error: Invalid API key")), true);
  assert.equal(isOpenSeaInvalidApiKeyError(new Error("API key expired")), true);
  assert.equal(isOpenSeaInvalidApiKeyError(new Error("Too many requests")), false);
});

function signedResponse(overrides: { nft?: string; quantity?: number; stageIndex?: number; recipient?: string; feeRecipient?: string } = {}) {
  const data = new ethers.Interface(mintAbi).encodeFunctionData("mintSigned", [
    overrides.nft || collectionAddress,
    overrides.feeRecipient || feeRecipient,
    overrides.recipient || ethers.ZeroAddress,
    overrides.quantity || 1,
    {
      mintPrice: 0,
      maxTotalMintableByWallet: 1,
      startTime: Date.parse(stage.startsAt) / 1000,
      endTime: Date.parse(stage.endsAt) / 1000,
      dropStageIndex: overrides.stageIndex ?? 2,
      maxTokenSupplyForStage: 4500,
      feeBps: 1000,
      restrictFeeRecipients: true,
    },
    123,
    `0x${"ab".repeat(65)}`,
  ]);
  return { to: seaDropAddress, data, value: "0x0", chain: "robinhood" };
}

test("OpenSea signed FCFS payload is decoded and bound to the reviewed wallet transaction", () => {
  const request = validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse());
  assert.equal(String(request.to).toLowerCase(), seaDropAddress.toLowerCase());
  assert.equal(request.value, 0n);
  assert.equal(request.chainId, 4663);
});

test("wallet-bound payload proves FCFS eligibility without weakening final transaction validation", () => {
  const payload = signedResponse({ feeRecipient: "0x2222222222222222222222222222222222222222" });
  assert.equal(eligibilityPhaseFromTransaction(collection, config, 1, payload), "fcfs");
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, payload), /fee recipient/);
});

test("eligibility payload proof rejects an unreviewed stage, collection, quantity, or missing signature", () => {
  assert.throws(() => eligibilityPhaseFromTransaction(collection, config, 1, signedResponse({ stageIndex: 99 })), /unreviewed stage/);
  assert.throws(() => eligibilityPhaseFromTransaction(collection, config, 1, signedResponse({ nft: ethers.ZeroAddress })), /different NFT contract/);
  assert.throws(() => eligibilityPhaseFromTransaction(collection, config, 1, signedResponse({ quantity: 2 })), /quantity/);
  const missingSignature = { ...signedResponse(), data: new ethers.Interface(mintAbi).encodeFunctionData("mintSigned", [
    collectionAddress, feeRecipient, ethers.ZeroAddress, 1,
    { mintPrice: 0, maxTotalMintableByWallet: 1, startTime: Date.parse(stage.startsAt) / 1000, endTime: Date.parse(stage.endsAt) / 1000, dropStageIndex: 2, maxTokenSupplyForStage: 4500, feeBps: 1000, restrictFeeRecipients: true },
    123, "0x",
  ]) };
  assert.throws(() => eligibilityPhaseFromTransaction(collection, config, 1, missingSignature), /signature is missing/);
});

test("OpenSea signed FCFS validation rejects another stage, NFT, quantity, or recipient", () => {
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ stageIndex: 1 })), /stage changed/);
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ nft: ethers.ZeroAddress })), /different NFT contract/);
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ quantity: 2 })), /quantity/);
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ recipient: "0x2222222222222222222222222222222222222222" })), /another wallet/);
});

test("an omitted GTD stage is skipped while a returned eligible FCFS stage is selected", () => {
  const gtd: ReviewedOpenSeaStage = {
    ...stage,
    id: "gtd",
    name: "GTDs",
    startsAt: "2026-08-13T17:00:00.000Z",
    endsAt: "2026-08-13T17:30:00.000Z",
    dropStageIndex: 1,
  };
  const apiStages = [
    { uuid: "gtd-uuid", stageType: "signed_presale", label: "GTDs", price: "0", startTime: gtd.startsAt, endTime: gtd.endsAt, maxPerWallet: "1" },
    { uuid: "fcfs-uuid", stageType: "signed_presale", label: "FCFs", price: "0", startTime: stage.startsAt, endTime: stage.endsAt, maxPerWallet: "1" },
  ];
  const result = mapSignedStageEligibility([gtd, stage], apiStages, [{
    stageUuid: "fcfs-uuid",
    isEligible: true,
    price: "0",
    maxTotalMintableByWallet: "1",
  }], 1);
  assert.deepEqual(result, [
    { phaseId: "gtd", status: "ineligible", reason: "Wallet is not eligible for GTDs" },
    { phaseId: "fcfs", status: "eligible" },
  ]);
});

test("a wallet payload can prove FCFS even while the eligibility list still reports GTD", () => {
  assert.deepEqual(applyPayloadEligibility([
    { phaseId: "gtd", status: "eligible" },
    { phaseId: "fcfs", status: "ineligible", reason: "Wallet is not eligible for FCFS" },
  ], "fcfs"), [
    { phaseId: "gtd", status: "eligible" },
    { phaseId: "fcfs", status: "eligible" },
  ]);
});

test("signed stage UUID matching tolerates casing, braces, and omitted hyphens", () => {
  const apiStages = [{
    uuid: "AABBCCDD-1111-2222-3333-444455556666",
    stageType: "signed_presale", label: "FCFs", price: "0",
    startTime: stage.startsAt, endTime: stage.endsAt, maxPerWallet: "1",
  }];
  assert.deepEqual(mapSignedStageEligibility([stage], apiStages, [{
    stageUuid: "{aabbccdd111122223333444455556666}", isEligible: true,
  }], 1), [{ phaseId: "fcfs", status: "eligible" }]);
});

test("a valid public eligibility record does not make an omitted signed stage unknown", () => {
  const publicStage = config.stages.find((item) => item.kind === "public")!;
  const apiStages = [
    { uuid: "aaaaaaaa-1111-2222-3333-444455556666", stageType: "signed_presale", label: "FCFs", price: "0", startTime: stage.startsAt, endTime: stage.endsAt, maxPerWallet: "1" },
    { uuid: "bbbbbbbb-1111-2222-3333-444455556666", stageType: "public_sale", label: "Public stage", price: publicStage.priceWei, startTime: publicStage.startsAt, endTime: publicStage.endsAt, maxPerWallet: "1" },
  ];
  assert.deepEqual(mapSignedStageEligibility(config.stages, apiStages, [{
    stageUuid: "bbbbbbbb111122223333444455556666", isEligible: true,
  }], 1), [{ phaseId: "fcfs", status: "ineligible", reason: "Wallet is not eligible for FCFs" }]);
});

test("an unmapped eligible OpenSea stage blocks public fallback with a diagnostic code", () => {
  const apiStages = [{
    uuid: "aaaaaaaa-1111-2222-3333-444455556666",
    stageType: "signed_presale", label: "FCFs", price: "0",
    startTime: stage.startsAt, endTime: stage.endsAt, maxPerWallet: "1",
  }];
  assert.deepEqual(mapSignedStageEligibility([stage], apiStages, [{
    stageUuid: "bbbbbbbb-1111-2222-3333-444455556666", isEligible: true,
  }], 1), [{
    phaseId: "fcfs",
    status: "unknown",
    reason: "OpenSea returned an unmapped eligible signed stage (bbbbbbbb)",
  }]);
});
