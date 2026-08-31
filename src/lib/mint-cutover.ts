import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getMintAdapter } from "@/lib/adapters";
import type { SupportedCollection } from "@/lib/adapters/types";
import { certificationIntegrityError, collectionFromDefinition, hashMintDefinition, parseMintDefinition } from "@/lib/mint-definitions";
import { safeErrorMessage, stableHash, stableJson } from "@/lib/safety";
import { hashWalletAddress } from "@/lib/eligibility-artifacts";
import { MINT_CERTIFIER_VERSION } from "@/lib/mint-certification";

export type CanonicalMintIntent = { chainId: number; to: string; data: string; value: string };

export function canonicalMintIntent(request: ethers.TransactionRequest): CanonicalMintIntent {
  const chainId = Number(request.chainId);
  const to = String(request.to || "").toLowerCase();
  const data = String(request.data || "0x").toLowerCase();
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !ethers.isAddress(to) || !ethers.isHexString(data)) {
    throw new Error("Transaction intent is incomplete");
  }
  return { chainId, to, data, value: BigInt(request.value ?? 0).toString() };
}

export function compareMintIntents(legacyRequest: ethers.TransactionRequest, candidateRequest: ethers.TransactionRequest) {
  const legacy = canonicalMintIntent(legacyRequest);
  const candidate = canonicalMintIntent(candidateRequest);
  const changedFields = (Object.keys(legacy) as Array<keyof CanonicalMintIntent>).filter((key) => legacy[key] !== candidate[key]);
  return {
    status: changedFields.length ? "mismatch" as const : "match" as const,
    legacyIntentHash: stableHash(legacy),
    candidateIntentHash: stableHash(candidate),
    diff: {
      changedFields,
      legacySelector: legacy.data.slice(0, 10),
      candidateSelector: candidate.data.slice(0, 10),
      legacyTarget: legacy.to,
      candidateTarget: candidate.to,
      legacyValue: legacy.value,
      candidateValue: candidate.value,
    },
  };
}

type ShadowInput = {
  jobId: string;
  collection: SupportedCollection;
  walletAddress: string;
  quantity: number;
  phaseId: string;
  provider: ethers.Provider;
  legacyRequest: ethers.TransactionRequest;
  allowBeforeStart?: boolean;
};

class ShadowCandidateError extends Error {
  constructor(readonly candidateVersionId: string, message: string) { super(message); }
}

async function certifiedCandidate(collection: SupportedCollection) {
  const [state] = await db.select().from(schema.mintCutoverStates).where(and(
    eq(schema.mintCutoverStates.collectionId, collection.id),
    or(eq(schema.mintCutoverStates.status, "shadow"), eq(schema.mintCutoverStates.status, "ready")),
  )).limit(1);
  if (!state) return null;
  try {
    const [version] = await db.select().from(schema.mintDefinitionVersions).where(and(
      eq(schema.mintDefinitionVersions.id, state.candidateDefinitionVersionId),
      eq(schema.mintDefinitionVersions.collectionId, collection.id),
      eq(schema.mintDefinitionVersions.status, "certified"),
    )).limit(1);
    if (!version) throw new Error("Shadow candidate is not a certified definition");
    const definition = parseMintDefinition(version.definitionJson);
    if (hashMintDefinition(definition) !== version.definitionHash) throw new Error("Shadow candidate definition failed integrity validation");
    const now = new Date().toISOString();
    const certificates = await db.select().from(schema.mintCertifications).where(and(
      eq(schema.mintCertifications.definitionVersionId, version.id),
      eq(schema.mintCertifications.definitionHash, version.definitionHash),
      eq(schema.mintCertifications.status, "passed"),
      eq(schema.mintCertifications.runnerVersion, MINT_CERTIFIER_VERSION),
      gt(schema.mintCertifications.expiresAt, now),
    )).orderBy(desc(schema.mintCertifications.certifiedAt)).limit(10);
    if (!certificates.some((item) => !certificationIntegrityError(item, version.definitionHash))) {
      throw new Error("Shadow candidate has no valid hash-bound certification");
    }
    return { state, version, collection: collectionFromDefinition(collection, definition) };
  } catch (error) {
    throw new ShadowCandidateError(state.candidateDefinitionVersionId, safeErrorMessage(error, "Shadow candidate validation failed"));
  }
}

async function persistComparison(input: ShadowInput, candidateVersionId: string, comparison: {
  status: "match" | "mismatch" | "error";
  legacyIntentHash?: string;
  candidateIntentHash?: string;
  diff: Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-cutover:${input.collection.id}`}))`);
    const [liveState] = await tx.select({ status: schema.mintCutoverStates.status, auditCycle: schema.mintCutoverStates.auditCycle }).from(schema.mintCutoverStates).where(and(
      eq(schema.mintCutoverStates.collectionId, input.collection.id),
      eq(schema.mintCutoverStates.candidateDefinitionVersionId, candidateVersionId),
      or(eq(schema.mintCutoverStates.status, "shadow"), eq(schema.mintCutoverStates.status, "ready")),
    )).limit(1);
    // A comparison that finished after activation must never reopen cutover.
    if (!liveState) return;
    const inserted = await tx.insert(schema.mintShadowComparisons).values({
      id: randomUUID(), collectionId: input.collection.id, candidateDefinitionVersionId: candidateVersionId,
      auditCycle: liveState.auditCycle, jobId: input.jobId, phaseId: input.phaseId, walletAddressHash: stableHash(input.walletAddress.toLowerCase()),
      quantity: input.quantity, legacyIntentHash: comparison.legacyIntentHash || null,
      candidateIntentHash: comparison.candidateIntentHash || null, status: comparison.status,
      diffJson: stableJson(comparison.diff), createdAt: now,
    }).onConflictDoNothing().returning({ id: schema.mintShadowComparisons.id });
    if (!inserted.length) return;
    await tx.update(schema.mintCutoverStates).set({
      matchedCount: comparison.status === "match" ? sql`${schema.mintCutoverStates.matchedCount} + 1` : sql`${schema.mintCutoverStates.matchedCount}`,
      mismatchedCount: comparison.status === "mismatch" ? sql`${schema.mintCutoverStates.mismatchedCount} + 1` : sql`${schema.mintCutoverStates.mismatchedCount}`,
      errorCount: comparison.status === "error" ? sql`${schema.mintCutoverStates.errorCount} + 1` : sql`${schema.mintCutoverStates.errorCount}`,
      lastComparisonAt: now,
      reason: comparison.status === "match" ? null : `Shadow ${comparison.status}: ${String(comparison.diff.error || comparison.diff.changedFields || "intent differs")}`,
      status: comparison.status === "match" ? sql`${schema.mintCutoverStates.status}` : "shadow",
      updatedAt: now,
    }).where(and(
      eq(schema.mintCutoverStates.collectionId, input.collection.id),
      eq(schema.mintCutoverStates.candidateDefinitionVersionId, candidateVersionId),
    ));
  });
}

/** Runs away from the broadcast path. Errors become audit evidence and never
 * alter the legacy transaction being executed. */
export async function recordShadowMintIntent(input: ShadowInput): Promise<void> {
  let candidateVersionId: string | undefined;
  try {
    const candidate = await certifiedCandidate(input.collection);
    if (!candidate) return;
    candidateVersionId = candidate.version.id;
    const adapter = getMintAdapter(candidate.collection.adapterKey);
    if (!adapter?.buildTransaction) throw new Error("Shadow candidate adapter cannot build a transaction");
    const [artifact] = await db.select({ id: schema.mintEligibilityArtifacts.id, artifactHash: schema.mintEligibilityArtifacts.artifactHash })
      .from(schema.mintEligibilityArtifacts).where(and(
        eq(schema.mintEligibilityArtifacts.collectionId, input.collection.id),
        eq(schema.mintEligibilityArtifacts.definitionVersionId, candidate.version.id),
        eq(schema.mintEligibilityArtifacts.definitionHash, candidate.version.definitionHash),
        eq(schema.mintEligibilityArtifacts.phaseId, input.phaseId),
        eq(schema.mintEligibilityArtifacts.walletAddressHash, hashWalletAddress(input.walletAddress)),
        or(isNull(schema.mintEligibilityArtifacts.expiresAt), gt(schema.mintEligibilityArtifacts.expiresAt, new Date().toISOString())),
      )).limit(1);
    const request = await adapter.buildTransaction(candidate.collection, input.walletAddress, input.quantity, input.provider, {
      phaseId: input.phaseId,
      allowBeforeStart: input.allowBeforeStart,
      eligibilityArtifactId: artifact?.id || null,
      eligibilityArtifactHash: artifact?.artifactHash || null,
    });
    await persistComparison(input, candidate.version.id, compareMintIntents(input.legacyRequest, request));
  } catch (error) {
    if (error instanceof ShadowCandidateError) candidateVersionId = error.candidateVersionId;
    if (!candidateVersionId) return;
    await persistComparison(input, candidateVersionId, {
      status: "error",
      legacyIntentHash: stableHash(canonicalMintIntent(input.legacyRequest)),
      diff: { error: safeErrorMessage(error, "Shadow comparison failed") },
    });
  }
}

export function cutoverReadiness(input: { requiredSamples: number; matchedCount: number; mismatchedCount: number; errorCount: number }) {
  const blockers: string[] = [];
  if (input.mismatchedCount > 0) blockers.push(`${input.mismatchedCount} intent mismatch(es) must be resolved in a new audit cycle`);
  if (input.errorCount > 0) blockers.push(`${input.errorCount} shadow comparison error(s) must be resolved in a new audit cycle`);
  if (input.matchedCount < input.requiredSamples) blockers.push(`${input.requiredSamples - input.matchedCount} more exact match(es) required`);
  return { ready: blockers.length === 0, blockers };
}
