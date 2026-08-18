import assert from "node:assert/strict";
import test from "node:test";
import projects from "../config/supported-projects.json" with { type: "json" };
import { executionEngineFor, executionEngineProfiles, executionManifestFor } from "../src/lib/engines/index";

test("every supported project selects a validated reusable execution engine", () => {
  for (const project of projects) {
    const collection = {
      ...project,
      mintPrice: project.mintPrice ?? null,
      maxPerWallet: project.maxPerWallet ?? null,
      maxSupply: project.maxSupply ?? null,
      mintMethod: project.mintMethod ?? "mint",
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
    };
    const manifest = executionManifestFor(collection);
    assert.equal(executionEngineFor(collection).key, manifest.engine, project.name);
  }
});

test("latency-sensitive engines fail closed on final pinned-state validation", () => {
  for (const profile of executionEngineProfiles().filter((item) => item.broadcast === "sequencer-first")) {
    assert.equal(profile.finalPinnedStateRequired, true, profile.key);
  }
});
