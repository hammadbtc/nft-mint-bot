import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  validateOpenSeaSignedTransaction,
  type ReviewedOpenSeaStage,
  type SignedSeaDropConfig,
} from "../src/lib/adapters/opensea-signed-seadrop-v1";

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

function signedResponse(overrides: { nft?: string; quantity?: number; stageIndex?: number; recipient?: string } = {}) {
  const data = new ethers.Interface(mintAbi).encodeFunctionData("mintSigned", [
    overrides.nft || collectionAddress,
    feeRecipient,
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

test("OpenSea signed FCFS validation rejects another stage, NFT, quantity, or recipient", () => {
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ stageIndex: 1 })), /stage changed/);
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ nft: ethers.ZeroAddress })), /different NFT contract/);
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ quantity: 2 })), /quantity/);
  assert.throws(() => validateOpenSeaSignedTransaction(collection, config, stage, signerAddress, 1, signedResponse({ recipient: "0x2222222222222222222222222222222222222222" })), /another wallet/);
});
