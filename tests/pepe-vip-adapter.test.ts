import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import projects from "../config/supported-projects.json" with { type: "json" };
import {
  openseaSignedSeaDropV1,
  validateOpenSeaSignedTransaction,
  type SignedSeaDropConfig,
} from "../src/lib/adapters/opensea-signed-seadrop-v1";
import type { SupportedCollection } from "../src/lib/adapters/types";

const project = projects.find((item) => item.slug === "pepe-vip-official")!;
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

const observedVipMintInput = "0x4b61cd6f00000000000000000000000014044a824c814eba2757a5d99643ec6aafbda7710000000000000000000000000000a26b00c1f0df003000390027140000faa7190000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006a8df443000000000000000000000000000000000000000000000000000000006a8e10630000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000001ac3fb182bc6de91e99c6c37f43d9a7dfe154007f085979d4ce1134b101df951900000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000041405d278aeea395897374896e1986962d201e4d81f76734d99a440ab1ccf0ec521126f553b0370c0698bc502d920b3887c94fe03f567d947202b62ccc57b5a99e1c000000000000000000000000000000000000000000000000000000000000003d958fe2";

test("Pepe VIP has exact signed/public arming capabilities", () => {
  assert.equal(openseaSignedSeaDropV1.canArmPhase?.("vip-list-fcfs"), true);
  assert.equal(openseaSignedSeaDropV1.requiresPayloadWarmup?.(collection, "vip-list-fcfs"), true);
  assert.equal(openseaSignedSeaDropV1.prearmedPayloadProvesEligibility?.(collection, "vip-list-fcfs"), true);
  assert.equal(openseaSignedSeaDropV1.canArmPhase?.("public"), true);
  assert.equal(openseaSignedSeaDropV1.requiresPayloadWarmup?.(collection, "public"), false);
  assert.equal(openseaSignedSeaDropV1.prearmedPayloadProvesEligibility?.(collection, "public"), false);
});

test("Pepe VIP observed VIP transaction matches the reviewed signed intent", () => {
  const stage = config.stages.find((item) => item.id === "vip-list-fcfs")!;
  const request = validateOpenSeaSignedTransaction(collection, config, stage, ethers.ZeroAddress, 1, {
    to: config.seaDropAddress,
    data: observedVipMintInput,
    value: "0",
    chain: "robinhood",
  });
  assert.equal(String(request.to).toLowerCase(), config.seaDropAddress.toLowerCase());
  assert.equal(request.chainId, 4663);
  assert.equal(request.value, 0n);
});

test("Pepe VIP public transaction can warm without an OpenSea signed payload", async () => {
  await assert.doesNotReject(() => openseaSignedSeaDropV1.warmTransaction!(
    collection,
    ethers.ZeroAddress,
    1,
    {} as ethers.Provider,
    { phaseId: "public" },
  ));
});
