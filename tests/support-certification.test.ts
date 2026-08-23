import assert from "node:assert/strict";
import test from "node:test";
import projects from "../config/supported-projects.json" with { type: "json" };
import { getMintAdapter } from "../src/lib/adapters/index";
import { executionManifestFor } from "../src/lib/engines/index";
import type { SupportedCollection } from "../src/lib/adapters/types";

type Stage = {
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

function asCollection(project: (typeof projects)[number]): SupportedCollection {
  return {
    ...project,
    mintPrice: project.mintPrice ?? null,
    maxPerWallet: project.maxPerWallet ?? null,
    maxSupply: project.maxSupply ?? null,
    mintAbi: JSON.stringify(project.mintAbi ?? []),
    domains: JSON.stringify(project.domains ?? []),
    adapterConfig: JSON.stringify(project.adapterConfig ?? {}),
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
    siteUrl: project.siteUrl ?? null,
    imageUrl: project.imageUrl ?? null,
    createdAt: new Date().toISOString(),
  } as SupportedCollection;
}

test("every seed has a registered adapter and deployable execution manifest", () => {
  for (const project of projects) {
    const collection = asCollection(project);
    assert.ok(getMintAdapter(collection.adapterKey), `${project.name}: adapter is not registered`);
    assert.doesNotThrow(() => executionManifestFor(collection), `${project.name}: execution manifest is invalid`);
  }
});

test("mixed OpenSea drops declare non-contradictory capabilities for every reviewed phase", () => {
  for (const project of projects.filter((item) => item.adapterKey === "opensea-signed-seadrop-v1")) {
    const collection = asCollection(project);
    const adapter = getMintAdapter(collection.adapterKey)!;
    const stages = (project.adapterConfig as { stages?: Stage[] }).stages || [];
    assert.ok(stages.length >= 2, `${project.name}: mixed drop must review every stage`);
    assert.equal(stages.filter((stage) => stage.kind === "public").length, 1, `${project.name}: exactly one public stage is required`);
    assert.equal(new Set(stages.map((stage) => stage.id)).size, stages.length, `${project.name}: stage IDs must be unique`);
    for (const stage of stages) {
      assert.ok(adapter.supportsArming, `${project.name}/${stage.id}: adapter must support arming`);
      assert.notEqual(adapter.canArmPhase?.(stage.id), false, `${project.name}/${stage.id}: phase is not armable`);
      const needsPayload = adapter.requiresPayloadWarmup?.(collection, stage.id) === true;
      const payloadProvesEligibility = adapter.prearmedPayloadProvesEligibility?.(collection, stage.id) === true;
      assert.equal(needsPayload, stage.kind === "signed", `${project.name}/${stage.id}: payload warming capability contradicts phase kind`);
      assert.equal(payloadProvesEligibility, stage.kind === "signed", `${project.name}/${stage.id}: payload eligibility capability contradicts phase kind`);
      if (needsPayload) assert.equal(typeof adapter.warmTransaction, "function", `${project.name}/${stage.id}: payload warmer is missing`);
      assert.ok(Date.parse(stage.startsAt) < Date.parse(stage.endsAt), `${project.name}/${stage.id}: phase window is invalid`);
      assert.match(stage.priceWei, /^\d+$/, `${project.name}/${stage.id}: price must be integer wei`);
      assert.ok(Number.isSafeInteger(stage.maxPerWallet) && stage.maxPerWallet > 0, `${project.name}/${stage.id}: wallet cap is invalid`);
    }
  }
});

test("signed OpenSea schedules are ordered and public configuration cannot masquerade as signed", () => {
  for (const project of projects.filter((item) => item.adapterKey === "opensea-signed-seadrop-v1")) {
    const stages = ((project.adapterConfig as { stages?: Stage[] }).stages || []);
    for (let index = 1; index < stages.length; index += 1) {
      assert.ok(Date.parse(stages[index].startsAt) >= Date.parse(stages[index - 1].startsAt), `${project.name}: stages are not chronological`);
    }
    for (const stage of stages) {
      if (stage.kind === "public") {
        assert.equal(stage.dropStageIndex, undefined, `${project.name}/${stage.id}: public stage must not carry a signed stage index`);
        assert.equal(stage.maxTokenSupplyForStage, undefined, `${project.name}/${stage.id}: public stage must read supply on-chain`);
      } else {
        assert.ok(Number.isSafeInteger(stage.dropStageIndex), `${project.name}/${stage.id}: signed stage index is missing`);
        assert.ok(Number.isSafeInteger(stage.maxTokenSupplyForStage), `${project.name}/${stage.id}: signed stage supply is missing`);
        assert.ok(Number.isSafeInteger(stage.feeBps), `${project.name}/${stage.id}: signed stage fee is missing`);
        assert.equal(typeof stage.restrictFeeRecipients, "boolean", `${project.name}/${stage.id}: fee-recipient restriction is missing`);
      }
    }
  }
});
