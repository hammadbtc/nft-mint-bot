import type { SupportedCollection } from "@/lib/adapters/types";
import type { ExecutionEngineKey, ExecutionEngineProfile, ExecutionManifest } from "./types";

const PROFILES: Record<ExecutionEngineKey, ExecutionEngineProfile> = {
  "scheduled-public-v1": {
    key: "scheduled-public-v1",
    detection: "precise-timer",
    preparation: "static-prearm",
    broadcast: "sequencer-first",
    supportsNonceLadder: true,
    requiresDedicatedWalletForLadder: true,
    launchTimeGasEstimation: false,
    finalPinnedStateRequired: true,
  },
  "scheduled-server-signed-v1": {
    key: "scheduled-server-signed-v1",
    detection: "provider-payload",
    preparation: "static-prearm",
    broadcast: "sequencer-first",
    supportsNonceLadder: false,
    requiresDedicatedWalletForLadder: false,
    launchTimeGasEstimation: false,
    finalPinnedStateRequired: true,
  },
  "stealth-owner-switch-v1": {
    key: "stealth-owner-switch-v1",
    detection: "owner-switch",
    preparation: "switch-gated",
    broadcast: "sequencer-first",
    supportsNonceLadder: true,
    requiresDedicatedWalletForLadder: true,
    launchTimeGasEstimation: false,
    finalPinnedStateRequired: true,
  },
  "sequential-confirmed-v1": {
    key: "sequential-confirmed-v1",
    detection: "owner-switch",
    preparation: "switch-gated",
    broadcast: "standard",
    supportsNonceLadder: false,
    supportsSequentialTransactions: true,
    requiresDedicatedWalletForLadder: false,
    launchTimeGasEstimation: true,
    finalPinnedStateRequired: true,
  },
  "custom-reviewed-v1": {
    key: "custom-reviewed-v1",
    detection: "precise-timer",
    preparation: "static-prearm",
    broadcast: "standard",
    supportsNonceLadder: false,
    requiresDedicatedWalletForLadder: false,
    launchTimeGasEstimation: true,
    finalPinnedStateRequired: true,
  },
};

const LEGACY_ADAPTER_ENGINE: Record<string, ExecutionEngineKey> = {
  "opensea-seadrop-v1": "scheduled-public-v1",
  "opensea-signed-seadrop-v1": "scheduled-server-signed-v1",
  "bulls-runners-v1": "stealth-owner-switch-v1",
  "terminal-assistants-v1": "stealth-owner-switch-v1",
  "cookiez-free-v1": "sequential-confirmed-v1",
  "squiggle-wuiggle-v1": "custom-reviewed-v1",
  "evm-contract-v1": "custom-reviewed-v1",
};

function parseManifest(collection: SupportedCollection): Partial<ExecutionManifest> {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Mint project execution manifest is invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mint project execution manifest must be an object");
  return value as Partial<ExecutionManifest>;
}

export function executionManifestFor(collection: SupportedCollection): ExecutionManifest {
  const config = parseManifest(collection);
  const expected = LEGACY_ADAPTER_ENGINE[collection.adapterKey];
  if (!expected) throw new Error(`Adapter ${collection.adapterKey} has no reviewed execution engine`);
  if (!config.engine) throw new Error(`${collection.name} is missing its execution engine manifest`);
  if (!(config.engine in PROFILES)) throw new Error(`${collection.name} selects an unknown execution engine`);
  if (config.engine !== expected) throw new Error(`${collection.name} execution engine does not match its reviewed adapter`);
  if (config.maxPreparedTransactions != null && (!Number.isSafeInteger(config.maxPreparedTransactions) || config.maxPreparedTransactions < 1 || config.maxPreparedTransactions > 100)) {
    throw new Error(`${collection.name} has an invalid prepared-transaction limit`);
  }
  if (config.onePerTransaction && !PROFILES[config.engine].supportsNonceLadder && !PROFILES[config.engine].supportsSequentialTransactions) {
    throw new Error(`${collection.name} requests sequential transactions on an engine that does not support them`);
  }
  return {
    engine: config.engine,
    onePerTransaction: config.onePerTransaction === true,
    maxPreparedTransactions: config.maxPreparedTransactions,
  };
}

export function executionEngineFor(collection: SupportedCollection): ExecutionEngineProfile {
  return PROFILES[executionManifestFor(collection).engine];
}

export function executionEngineProfiles(): ExecutionEngineProfile[] {
  return Object.values(PROFILES);
}
