import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { leaseExpiry, recoverMintJob, runMintJob } from "@/lib/engine/mint";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";
import { processDisperseOperations, recoverDisperseOperation } from "@/lib/disperse";

const DEFAULT_MAX_CONCURRENT = 5;
const RECOVERY_INTERVAL_MS = 15_000;

interface SchedulerRuntimeState {
  schedulerInterval: ReturnType<typeof setInterval> | null;
  recoveryInterval: ReturnType<typeof setInterval> | null;
  activeConcurrency: number;
  tickRunning: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  signalHandlersRegistered: boolean;
}

// Next.js can bundle instrumentation and route handlers as separate module
// instances in the same Node process. Keep the scheduler state on `process`
// so every bundle observes and controls the same scheduler singleton.
const schedulerHost = process as NodeJS.Process & {
  __mintbotSchedulerRuntime?: SchedulerRuntimeState;
};
const state = schedulerHost.__mintbotSchedulerRuntime ??= {
  schedulerInterval: null,
  recoveryInterval: null,
  activeConcurrency: DEFAULT_MAX_CONCURRENT,
  tickRunning: false,
  lastTickAt: null,
  lastError: null,
  signalHandlersRegistered: false,
};

export async function recoverStaleWork(): Promise<void> {
  const now = new Date().toISOString();
  const staleMintJobs = await db.select({ id: schema.mintJobs.id }).from(schema.mintJobs).where(
    and(
      inArray(schema.mintJobs.status, ["running", "confirming"]),
      or(isNull(schema.mintJobs.leaseExpiresAt), lt(schema.mintJobs.leaseExpiresAt, now)),
    ),
  ).limit(100);
  for (const job of staleMintJobs) await recoverMintJob(job.id).catch((error) => { state.lastError = safeErrorMessage(error); });

  const staleDisperse = await db.select({ id: schema.disperseOperations.id }).from(schema.disperseOperations).where(
    and(
      inArray(schema.disperseOperations.status, ["running", "confirming"]),
      or(isNull(schema.disperseOperations.leaseExpiresAt), lt(schema.disperseOperations.leaseExpiresAt, now)),
    ),
  ).limit(50);
  for (const operation of staleDisperse) await recoverDisperseOperation(operation.id).catch((error) => { state.lastError = safeErrorMessage(error); });
}

export async function processScheduledJobs(maxConcurrent = state.activeConcurrency): Promise<number> {
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
    running.push(runMintJob(job.id).catch((error) => { state.lastError = safeErrorMessage(error); }));
    if (running.length >= maxConcurrent) break;
  }
  await Promise.allSettled(running);
  return running.length;
}

async function tick(): Promise<void> {
  if (state.tickRunning) return;
  state.tickRunning = true;
  state.lastTickAt = new Date().toISOString();
  try {
    await Promise.all([processScheduledJobs(), processDisperseOperations(Math.max(1, Math.floor(state.activeConcurrency / 2)))]);
    state.lastError = null;
  } catch (error) {
    state.lastError = safeErrorMessage(error, "Scheduler tick failed");
  } finally {
    state.tickRunning = false;
  }
}

export function startScheduler(): void {
  if (state.schedulerInterval) return;
  void recoverStaleWork();
  state.schedulerInterval = setInterval(() => void tick(), 2_000);
  state.recoveryInterval = setInterval(() => void recoverStaleWork(), RECOVERY_INTERVAL_MS);
  if (!state.signalHandlersRegistered) {
    state.signalHandlersRegistered = true;
    process.once("SIGTERM", stopScheduler);
    process.once("SIGINT", stopScheduler);
  }
}

export function stopScheduler(): void {
  if (state.schedulerInterval) clearInterval(state.schedulerInterval);
  if (state.recoveryInterval) clearInterval(state.recoveryInterval);
  state.schedulerInterval = null;
  state.recoveryInterval = null;
  state.tickRunning = false;
}

export function setSchedulerConcurrency(value: number): void {
  state.activeConcurrency = Math.max(1, Math.min(value, 20));
}

export function schedulerStatus() {
  return {
    running: Boolean(state.schedulerInterval),
    tickRunning: state.tickRunning,
    concurrency: state.activeConcurrency,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
  };
}
