import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { safeErrorMessage, stableHash, stableJson } from "@/lib/safety";

type IncidentInput = {
  trigger: string;
  job: Record<string, unknown>;
  attempts: Array<Record<string, unknown>>;
  broadcasts: Array<Record<string, unknown>>;
  stages: Array<Record<string, unknown>>;
  controls: Array<Record<string, unknown>>;
  cutover: Record<string, unknown> | null;
  shadowComparisons: Array<Record<string, unknown>>;
};

const FORBIDDEN_KEYS = /rawtx|encrypted|private.?key|mnemonic|secret|password|token$|payload|definitionSnapshot/i;

export function redactIncidentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactIncidentValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, FORBIDDEN_KEYS.test(key) ? "[REDACTED]" : redactIncidentValue(item)]));
  }
  if (typeof value === "string") return safeErrorMessage(value, "[REDACTED]");
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function buildIncidentReplayBundle(input: IncidentInput) {
  return redactIncidentValue({ bundleVersion: 1, ...input }) as Record<string, unknown>;
}

export async function createIncidentReplayBundle(jobId: string, trigger: string) {
  const [job] = await db.select({
    id: schema.mintJobs.id, walletId: schema.mintJobs.walletId, collectionId: schema.mintJobs.collectionId,
    definitionVersionId: schema.mintJobs.definitionVersionId, definitionHash: schema.mintJobs.definitionHash,
    eligibilityArtifactHash: schema.mintJobs.eligibilityArtifactHash, status: schema.mintJobs.status,
    quantity: schema.mintJobs.quantity, phaseId: schema.mintJobs.phaseId, scheduledAt: schema.mintJobs.scheduledAt,
    armedAt: schema.mintJobs.armedAt, launchTargetAt: schema.mintJobs.launchTargetAt,
    preflightCheckedAt: schema.mintJobs.preflightCheckedAt, timerFiredAt: schema.mintJobs.timerFiredAt,
    timingDriftMs: schema.mintJobs.timingDriftMs, retryCount: schema.mintJobs.retryCount,
    maxRetries: schema.mintJobs.maxRetries, nonce: schema.mintJobs.nonce, dryRun: schema.mintJobs.dryRun,
    error: schema.mintJobs.error, createdAt: schema.mintJobs.createdAt, startedAt: schema.mintJobs.startedAt,
    completedAt: schema.mintJobs.completedAt, updatedAt: schema.mintJobs.updatedAt,
  }).from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
  if (!job) throw new Error("Mint job was not found");
  const [attempts, stages, controls, cutover, shadows] = await Promise.all([
    db.select({ id: schema.mintAttempts.id, status: schema.mintAttempts.status, kind: schema.mintAttempts.kind,
      txHash: schema.mintAttempts.txHash, nonce: schema.mintAttempts.nonce, toAddress: schema.mintAttempts.toAddress,
      value: schema.mintAttempts.value, dataHash: schema.mintAttempts.dataHash, preflightHash: schema.mintAttempts.preflightHash,
      gasLimit: schema.mintAttempts.gasLimit, maxFeePerGas: schema.mintAttempts.maxFeePerGas,
      maxPriorityFeePerGas: schema.mintAttempts.maxPriorityFeePerGas, gasUsed: schema.mintAttempts.gasUsed,
      effectiveGasPrice: schema.mintAttempts.effectiveGasPrice, blockNumber: schema.mintAttempts.blockNumber,
      error: schema.mintAttempts.error, preparedAt: schema.mintAttempts.preparedAt, broadcastAt: schema.mintAttempts.broadcastAt,
      confirmedAt: schema.mintAttempts.confirmedAt, createdAt: schema.mintAttempts.createdAt,
    }).from(schema.mintAttempts).where(eq(schema.mintAttempts.jobId, jobId)),
    db.select().from(schema.mintStageEvents).where(eq(schema.mintStageEvents.jobId, jobId)),
    db.select().from(schema.mintControlEvents).where(eq(schema.mintControlEvents.collectionId, job.collectionId)),
    db.select().from(schema.mintCutoverStates).where(eq(schema.mintCutoverStates.collectionId, job.collectionId)).limit(1),
    db.select().from(schema.mintShadowComparisons).where(eq(schema.mintShadowComparisons.jobId, jobId)),
  ]);
  const broadcasts = attempts.length ? await db.select().from(schema.mintBroadcasts)
    .where(inArray(schema.mintBroadcasts.attemptId, attempts.map((item) => item.id))) : [];
  const bundle = buildIncidentReplayBundle({
    trigger, job, attempts, broadcasts, stages, controls, cutover: cutover[0] || null, shadowComparisons: shadows,
  });
  const bundleJson = stableJson(bundle);
  const bundleHash = stableHash(bundle);
  const id = randomUUID();
  await db.insert(schema.mintIncidentBundles).values({ id, jobId, trigger, bundleJson, bundleHash })
    .onConflictDoNothing({ target: schema.mintIncidentBundles.bundleHash });
  const [stored] = await db.select().from(schema.mintIncidentBundles)
    .where(eq(schema.mintIncidentBundles.bundleHash, bundleHash)).limit(1);
  if (!stored) throw new Error("Incident bundle could not be persisted");
  return { id: stored.id, jobId, trigger: stored.trigger, bundleHash, bundle: JSON.parse(stored.bundleJson) as Record<string, unknown>, createdAt: stored.createdAt };
}

