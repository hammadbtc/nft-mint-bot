import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { leaseExpiry, recoverMintJob, runMintJob } from "@/lib/engine/mint";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";
import { processDisperseOperations, recoverDisperseOperation } from "@/lib/disperse";

const DEFAULT_MAX_CONCURRENT = 5;
const RECOVERY_INTERVAL_MS = 15_000;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let recoveryInterval: ReturnType<typeof setInterval> | null = null;
let activeConcurrency = DEFAULT_MAX_CONCURRENT;
let tickRunning = false;
let lastTickAt: string | null = null;
let lastError: string | null = null;

export async function recoverStaleWork(): Promise<void> {
  const now = new Date().toISOString();
  const staleMintJobs = await db.select({ id: schema.mintJobs.id }).from(schema.mintJobs).where(
    and(
      inArray(schema.mintJobs.status, ["running", "confirming"]),
      or(isNull(schema.mintJobs.leaseExpiresAt), lt(schema.mintJobs.leaseExpiresAt, now)),
    ),
  ).limit(100);
  for (const job of staleMintJobs) await recoverMintJob(job.id).catch((error) => { lastError = safeErrorMessage(error); });

  const staleDisperse = await db.select({ id: schema.disperseOperations.id }).from(schema.disperseOperations).where(
    and(
      inArray(schema.disperseOperations.status, ["running", "confirming"]),
      or(isNull(schema.disperseOperations.leaseExpiresAt), lt(schema.disperseOperations.leaseExpiresAt, now)),
    ),
  ).limit(50);
  for (const operation of staleDisperse) await recoverDisperseOperation(operation.id).catch((error) => { lastError = safeErrorMessage(error); });
}

export async function processScheduledJobs(maxConcurrent = activeConcurrency): Promise<number> {
  const now = new Date().toISOString();
  const liveEnabled = liveTransactionsEnabled();
  const candidates = await db.select().from(schema.mintJobs).where(
    and(
      eq(schema.mintJobs.status, "pending"),
      or(isNull(schema.mintJobs.scheduledAt), lte(schema.mintJobs.scheduledAt, now)),
      liveEnabled ? undefined : eq(schema.mintJobs.dryRun, true),
    ),
  ).orderBy(asc(schema.mintJobs.priority), asc(schema.mintJobs.createdAt)).limit(maxConcurrent * 3);

  const running: Promise<unknown>[] = [];
  for (const job of candidates) {
    const claimToken = randomUUID();
    const claimed = await db.update(schema.mintJobs).set({
      status: "running",
      claimToken,
      claimedAt: now,
      leaseExpiresAt: leaseExpiry(),
      startedAt: job.startedAt || now,
      updatedAt: now,
    }).where(and(eq(schema.mintJobs.id, job.id), eq(schema.mintJobs.status, "pending")))
      .returning({ id: schema.mintJobs.id });
    if (!claimed.length) continue;
    running.push(runMintJob(job.id).catch((error) => { lastError = safeErrorMessage(error); }));
    if (running.length >= maxConcurrent) break;
  }
  await Promise.allSettled(running);
  return running.length;
}

async function tick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  lastTickAt = new Date().toISOString();
  try {
    await Promise.all([processScheduledJobs(), processDisperseOperations(Math.max(1, Math.floor(activeConcurrency / 2)))]);
    lastError = null;
  } catch (error) {
    lastError = safeErrorMessage(error, "Scheduler tick failed");
  } finally {
    tickRunning = false;
  }
}

export function startScheduler(): void {
  if (schedulerInterval) return;
  void recoverStaleWork();
  schedulerInterval = setInterval(() => void tick(), 2_000);
  recoveryInterval = setInterval(() => void recoverStaleWork(), RECOVERY_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  if (recoveryInterval) clearInterval(recoveryInterval);
  schedulerInterval = null;
  recoveryInterval = null;
}

export function setSchedulerConcurrency(value: number): void {
  activeConcurrency = Math.max(1, Math.min(value, 20));
}

export function schedulerStatus() {
  return {
    running: Boolean(schedulerInterval),
    tickRunning,
    concurrency: activeConcurrency,
    lastTickAt,
    lastError,
  };
}
