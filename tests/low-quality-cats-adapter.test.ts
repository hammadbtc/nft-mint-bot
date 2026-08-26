import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import projects from "../config/supported-projects.json" with { type: "json" };
import { encodeSeaDropPublicMint } from "../src/lib/adapters/opensea-seadrop-v1";
import {
  openseaSignedSeaDropV1,
  validateOpenSeaSignedTransaction,
  type SignedSeaDropConfig,
} from "../src/lib/adapters/opensea-signed-seadrop-v1";
import type { SupportedCollection } from "../src/lib/adapters/types";

const project = projects.find((item) => item.slug === "low-quality-cats")!;
const config = project.adapterConfig as SignedSeaDropConfig;
const collection = {
  ...project,
  mintAbi: JSON.stringify(project.mintAbi),
  domains: JSON.stringify(project.domains),
  adapterConfig: JSON.stringify(project.adapterConfig),
  verified: true,
  active: true,
  defaultGasLimit: null,
  defaultMaxFeePerGas: null,
  defaultMaxPriorityFeePerGas: null,
  defaultUseFlashbots: false,
  fcfsEnabled: false,
  fcfsMintOpenSignature: null,
  paymentToken: null,
  safetyCheck: true,
  createdAt: new Date().toISOString(),
} as SupportedCollection;

const observedFcfsMintInput = "0x4b61cd6f00000000000000000000000055afd2187d7c312bf7e4ca7393a139df19f1f0960000000000000000000000000000a26b00c1f0df003000390027140000faa71900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000c6f3b40b6c0000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000006a8f4944000000000000000000000000000000000000000000000000000000006a8f8184000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000010ad00000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000001e79499a7134103d7913f44122d37540b66468b4b5c77a464188cdc6ed46dee8100000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000004112ba5597d8c0cae14f4ebf6a516304a0d4a09df7395937ec765eaf2c32f342cf484bf8efa8c57e8553179ce6e550e08a7d819f6171bb8a17cdb432a1f47931c51c000000000000000000000000000000000000000000000000000000000000003d958fe2";

test("Low Quality Cats public phase arms deterministically without an OpenSea payload", async () => {
  assert.equal(openseaSignedSeaDropV1.canArmPhase?.("public"), true);
  assert.equal(openseaSignedSeaDropV1.requiresPayloadWarmup?.(collection, "public"), false);
  assert.equal(openseaSignedSeaDropV1.prearmedPayloadProvesEligibility?.(collection, "public"), false);
  await assert.doesNotReject(() => openseaSignedSeaDropV1.warmTransaction!(
    collection, ethers.ZeroAddress, 1, {} as ethers.Provider, { phaseId: "public" },
  ));
});

test("Low Quality Cats public calldata is exact mintPublic calldata", () => {
  const data = encodeSeaDropPublicMint(
    project.contractAddress,
    config.feeRecipient,
    "0x1111111111111111111111111111111111111111",
    1,
  );
  const decoded = new ethers.Interface([
    "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
  ]).decodeFunctionData("mintPublic", data);
  assert.equal(decoded.nftContract.toLowerCase(), project.contractAddress.toLowerCase());
  assert.equal(decoded.feeRecipient.toLowerCase(), config.feeRecipient.toLowerCase());
  assert.equal(decoded.minterIfNotPayer, ethers.ZeroAddress);
  assert.equal(decoded.quantity, 1n);
});

test("Low Quality Cats observed FCFS payload matches the reviewed signed intent", () => {
  const stage = config.stages.find((item) => item.id === "fcfs")!;
  const request = validateOpenSeaSignedTransaction(collection, config, stage, ethers.ZeroAddress, 3, {
    to: config.seaDropAddress,
    data: observedFcfsMintInput,
    value: "10500000000000000",
    chain: "ethereum",
  });
  assert.equal(request.chainId, 1);
  assert.equal(request.value, 10_500_000_000_000_000n);
});
