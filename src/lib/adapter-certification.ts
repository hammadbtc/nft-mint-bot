import { ethers } from "ethers";
import type { SupportedCollection } from "@/lib/adapters/types";
import { validateReviewedCallConfig } from "@/lib/reviewed-call-config";

type ConfigPhase = { id?: string; name?: string };

function parsedConfig(collection: SupportedCollection): Record<string, unknown> {
  const value: unknown = JSON.parse(collection.adapterConfig || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Adapter configuration must be an object");
  return value as Record<string, unknown>;
}

function phaseIds(raw: unknown, fallbackPrefix = "phase"): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Adapter phase configuration is invalid");
    const phase = item as ConfigPhase;
    return phase.id || `${fallbackPrefix}-${index + 1}`;
  });
}

/** Every executable phase must have its own adapter-byte evidence. Keeping this
 * mapping explicit makes unsupported adapters fail closed during certification. */
export function certificationPhaseIds(collection: SupportedCollection): string[] {
  const config = parsedConfig(collection);
  switch (collection.adapterKey) {
    case "reviewed-call-v1":
      return validateReviewedCallConfig(collection).phases.map((phase) => phase.id);
    case "opensea-signed-seadrop-v1":
      return phaseIds(config.stages);
    case "evm-contract-v1": {
      const configured = phaseIds(config.phases);
      return configured.length ? configured : ["public"];
    }
    case "bulls-runners-v1": return ["whitelist", "open"];
    case "opensea-seadrop-v1": return ["public"];
    case "squiggle-wuiggle-v1": return ["public-fcfs"];
    case "terminal-assistants-v1": return ["open"];
    default: throw new Error(`Adapter ${collection.adapterKey} has no certification phase policy`);
  }
}

export function canonicalCertificationIntent(input: {
  chainId: number;
  to: string;
  data: string;
  value: bigint | string | number;
}) {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) throw new Error("Certification intent chain is invalid");
  if (!ethers.isAddress(input.to) || !ethers.isHexString(input.data)) throw new Error("Certification intent target or calldata is invalid");
  return {
    chainId: input.chainId,
    to: input.to.toLowerCase(),
    data: input.data.toLowerCase(),
    value: BigInt(input.value).toString(),
  };
}

export function assertExactCertificationIntent(
  expected: ReturnType<typeof canonicalCertificationIntent>,
  observed: ReturnType<typeof canonicalCertificationIntent>,
): void {
  for (const key of ["chainId", "to", "data", "value"] as const) {
    if (expected[key] !== observed[key]) throw new Error(`Adapter-built certification ${key} differs from the supplied fork transaction`);
  }
}
