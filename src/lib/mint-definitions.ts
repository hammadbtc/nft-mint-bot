import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { MINT_ERROR_CODES, MintSafetyError } from "@/lib/mint-errors";
import { stableHash, stableJson } from "@/lib/safety";
import type { SupportedCollection } from "@/lib/adapters/types";
import { deploymentVersion } from "@/lib/deployment";

export const MINT_DEFINITION_SCHEMA_VERSION = 1 as const;
export const MINT_DEFINITION_ENGINE_VERSION = "mint-definition-v1";

const nullableInteger = z.number().int().nullable();
const nullableString = z.string().nullable();

export const mintDefinitionSchema = z.object({
  schemaVersion: z.literal(MINT_DEFINITION_SCHEMA_VERSION),
  collectionId: z.string().min(1),
  name: z.string().min(1),
  contractAddress: z.string(),
  chainId: z.number().int().positive(),
  mintMethod: z.string().min(1),
  mintAbi: z.string(),
  mintPrice: nullableString,
  maxPerWallet: nullableInteger,
  maxSupply: nullableInteger,
  defaultGasLimit: nullableString,
  defaultMaxFeePerGas: nullableString,
  defaultMaxPriorityFeePerGas: nullableString,
  defaultUseFlashbots: z.boolean(),
  fcfsEnabled: z.boolean(),
  fcfsMintOpenSignature: nullableString,
  paymentToken: nullableString,
  safetyCheck: z.boolean(),
  slug: nullableString,
  adapterKey: z.string().min(1),
  domains: z.string(),
  siteUrl: nullableString,
  imageUrl: nullableString,
  adapterConfig: z.string(),
});

export type MintDefinitionSnapshot = z.infer<typeof mintDefinitionSchema>;

/** Capture only execution-critical fields. Mutable operational controls such
 * as active/verified/broadcastPaused remain live and fail closed at runtime. */
export function snapshotCollectionDefinition(collection: SupportedCollection): MintDefinitionSnapshot {
  return mintDefinitionSchema.parse({
    schemaVersion: MINT_DEFINITION_SCHEMA_VERSION,
    collectionId: collection.id,
    name: collection.name,
    contractAddress: collection.contractAddress,
    chainId: collection.chainId,
    mintMethod: collection.mintMethod,
    mintAbi: collection.mintAbi,
    mintPrice: collection.mintPrice,
    maxPerWallet: collection.maxPerWallet,
    maxSupply: collection.maxSupply,
    defaultGasLimit: collection.defaultGasLimit,
    defaultMaxFeePerGas: collection.defaultMaxFeePerGas,
    defaultMaxPriorityFeePerGas: collection.defaultMaxPriorityFeePerGas,
    defaultUseFlashbots: collection.defaultUseFlashbots,
    fcfsEnabled: collection.fcfsEnabled,
    fcfsMintOpenSignature: collection.fcfsMintOpenSignature,
    paymentToken: collection.paymentToken,
    safetyCheck: collection.safetyCheck,
    slug: collection.slug,
    adapterKey: collection.adapterKey,
    domains: collection.domains,
    siteUrl: collection.siteUrl,
    imageUrl: collection.imageUrl,
    adapterConfig: collection.adapterConfig,
  });
}

export function serializeMintDefinition(definition: MintDefinitionSnapshot): string {
  return stableJson(mintDefinitionSchema.parse(definition));
}

export function hashMintDefinition(definition: MintDefinitionSnapshot): string {
  return stableHash(mintDefinitionSchema.parse(definition));
}

export function parseMintDefinition(value: string): MintDefinitionSnapshot {
  return mintDefinitionSchema.parse(JSON.parse(value));
}

export function collectionFromDefinition(
  control: SupportedCollection,
  definition: MintDefinitionSnapshot,
): SupportedCollection {
  if (definition.collectionId !== control.id) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The task definition belongs to another collection");
  }
  return { ...control, ...definition, id: definition.collectionId };
}

export function collectionFromJobSnapshot(
  control: SupportedCollection,
  job: { definitionVersionId: string | null; definitionSnapshot: string | null; definitionHash: string | null },
): SupportedCollection {
  if (!job.definitionVersionId || !job.definitionSnapshot || !job.definitionHash) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The task has an incomplete definition pin");
  }
  let definition: MintDefinitionSnapshot;
  try {
    definition = parseMintDefinition(job.definitionSnapshot);
  } catch {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The task definition snapshot is invalid");
  }
  if (hashMintDefinition(definition) !== job.definitionHash) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The task definition hash does not match its snapshot");
  }
  return collectionFromDefinition(control, definition);
}

export function certificationIntegrityError(
  certificate: typeof schema.mintCertifications.$inferSelect,
  expectedDefinitionHash: string,
): string | null {
  if (certificate.definitionHash !== expectedDefinitionHash) return "Certification targets another definition hash";
  if (!["seed-certifier-v1", "mint-certifier-v1"].includes(certificate.runnerVersion)) return "Certification runner is not trusted";
  let evidence: unknown;
  let checks: unknown;
  try {
    evidence = JSON.parse(certificate.evidenceJson);
    checks = JSON.parse(certificate.checksJson);
  } catch {
    return "Certification evidence is invalid JSON";
  }
  if (stableHash(evidence) !== certificate.evidenceHash) {
    return "Certification evidence hash is invalid";
  }
  const expectedCertificateHash = stableHash({
    runnerVersion: certificate.runnerVersion,
    definitionHash: certificate.definitionHash,
    evidenceHash: certificate.evidenceHash,
    checksJson: stableJson(checks),
  });
  if (certificate.certificateHash !== expectedCertificateHash) return "Certification certificate hash is invalid";
  const currentCommit = deploymentVersion();
  if (certificate.runnerVersion === "mint-certifier-v1" && currentCommit !== "local" && !certificate.sourceCommit?.startsWith(currentCommit)) {
    return "Certification was produced by another deployment commit";
  }
  return null;
}

async function validPassedCertificateForVersion(versionId: string, definitionHash: string) {
  const now = new Date().toISOString();
  const certificates = await db.select().from(schema.mintCertifications).where(and(
    eq(schema.mintCertifications.definitionVersionId, versionId),
    eq(schema.mintCertifications.definitionHash, definitionHash),
    eq(schema.mintCertifications.status, "passed"),
    eq(schema.mintCertifications.runnerVersion, "mint-certifier-v1"),
    gt(schema.mintCertifications.expiresAt, now),
  )).orderBy(desc(schema.mintCertifications.certifiedAt)).limit(10);
  return certificates.find((certificate) => !certificationIntegrityError(certificate, definitionHash));
}

export async function validatedJobCollection(
  control: SupportedCollection,
  job: { definitionVersionId: string | null; definitionSnapshot: string | null; definitionHash: string | null },
): Promise<SupportedCollection> {
  const collection = collectionFromJobSnapshot(control, job);
  const [version] = await db.select().from(schema.mintDefinitionVersions).where(and(
    eq(schema.mintDefinitionVersions.id, job.definitionVersionId!),
    eq(schema.mintDefinitionVersions.collectionId, control.id),
  )).limit(1);
  if (!version || version.definitionHash !== job.definitionHash || version.status !== "active") {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The task definition is no longer the active version; review and reschedule it explicitly");
  }
  try {
    if (hashMintDefinition(parseMintDefinition(version.definitionJson)) !== version.definitionHash) throw new Error();
  } catch {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The stored task definition version failed its integrity check");
  }
  const certificate = await validPassedCertificateForVersion(version.id, version.definitionHash);
  if (!certificate) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionUncertified, "The task definition no longer has a valid certification");
  }
  return collection;
}

export async function scheduleMintDefinition(collection: SupportedCollection): Promise<{
  definitionVersionId: string;
  definitionHash: string;
  definitionSnapshot: string;
}> {
  const definition = snapshotCollectionDefinition(collection);
  const definitionHash = hashMintDefinition(definition);
  const [version] = await db.select().from(schema.mintDefinitionVersions).where(and(
    eq(schema.mintDefinitionVersions.collectionId, collection.id),
    eq(schema.mintDefinitionVersions.status, "active"),
  )).orderBy(desc(schema.mintDefinitionVersions.version)).limit(1);
  if (!version || !version.certifiedAt || !version.activatedAt) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionUncertified, "No certified active definition exists for this mint");
  }
  if (version.definitionHash !== definitionHash) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The active collection differs from its certified definition");
  }
  try {
    if (hashMintDefinition(parseMintDefinition(version.definitionJson)) !== version.definitionHash) throw new Error();
  } catch {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionMismatch, "The active definition version failed its integrity check");
  }
  const certificate = await validPassedCertificateForVersion(version.id, version.definitionHash);
  if (!certificate) {
    throw new MintSafetyError(MINT_ERROR_CODES.definitionUncertified, "The active definition has no valid passed certification");
  }
  return {
    definitionVersionId: version.id,
    definitionHash,
    definitionSnapshot: serializeMintDefinition(definition),
  };
}

export async function assertMintControls(collection: SupportedCollection, phaseId?: string | null): Promise<void> {
  if (collection.broadcastPaused) {
    throw new MintSafetyError(MINT_ERROR_CODES.projectPaused, collection.broadcastPauseReason || "Broadcasting is paused for this mint");
  }
  if (!phaseId) return;
  const [control] = await db.select().from(schema.mintPhaseControls).where(and(
    eq(schema.mintPhaseControls.collectionId, collection.id),
    eq(schema.mintPhaseControls.phaseId, phaseId),
  )).limit(1);
  if (control?.paused) {
    throw new MintSafetyError(MINT_ERROR_CODES.phasePaused, control.reason || `Broadcasting is paused for phase ${phaseId}`);
  }
}
