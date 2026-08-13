import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { failArmedJob, launchArmedJob, leaseExpiry, recoverMintJob, revalidateArmedJob, runMintJob } from "@/lib/engine/mint";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";
import { processDisperseOperations, recoverDisperseOperation } from "@/lib/disperse";
import { armLeadMs, revalidateLeadMs, schedulePrecisely } from "@/lib/launch-timing";
import { firstTaskPerWallet } from "@/lib/task-management";
import { schedulerHeartbeatFresh } from "./health";

const DEFAULT_MAX_CONCURRENT = 5;
const RECOVERY_INTERVAL_MS = 15_000;
const SCHEDULER_INTERVAL_MS = 250;
const CONFIRMATION_INTERVAL_MS = 1_000;

interface SchedulerRuntimeState {
  schedulerInterval: ReturnType<typeof setInterval> | null;
  recoveryInterval: ReturnType<typeof setInterval> | null;
  confirmationInterval: ReturnType<typeof setInterval> | null;
  launchTimers: Map<string, ReturnType<typeof setTimeout>>;
  revalidationTimers: Map<string, ReturnType<typeof setTimeout>>;
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
  confirmationInterval: null,
  launchTimers: new Map(),
  revalidationTimers: new Map(),
  activeConcurrency: DEFAULT_MAX_CONCURRENT,
  tickRunning: false,
  lastTickAt: null,
  lastError: null,
  signalHandlersRegistered: false,
};
state.confirmationInterval ??= null;
state.launchTimers ??= new Map();
state.revalidationTimers ??= new Map();

function clearArmedTimers(jobId: string): void {
  const launch = state.launchTimers.get(jobId);
  const revalidation = state.revalidationTimers.get(jobId);
  if (launch) clearTimeout(launch);
  if (revalidation) clearTimeout(revalidation);
  state.launchTimers.delete(jobId);
  state.revalidationTimers.delete(jobId);
}

function scheduleArmedTimers(jobId: string, targetAt: string): void {
  clearArmedTimers(jobId);
  const targetMs = Date.parse(targetAt);
  const revalidateAt = new Date(Math.max(Date.now(), targetMs - revalidateLeadMs())).toISOString();
  state.revalidationTimers.set(jobId, schedulePrecisely(revalidateAt, () => {
    void revalidateArmedJob(jobId).catch(async (error) => {
      state.lastError = safeErrorMessage(error);
      const launch = state.launchTimers.get(jobId);
      if (launch) clearTimeout(launch);
      state.launchTimers.delete(jobId);
      await failArmedJob(jobId, error);
    });
  }));
  state.launchTimers.set(jobId, schedulePrecisely(targetAt, (firedAt) => {
    state.launchTimers.delete(jobId);
    void launchArmedJob(jobId, firedAt).catch(async (error) => {
      state.lastError = safeErrorMessage(error);
      await failArmedJob(jobId, error);
    });
  }));
}

async function restoreArmedTimers(): Promise<void> {
  const jobs = await db.select({ id: schema.mintJobs.id, launchTargetAt: schema.mintJobs.launchTargetAt })
    .from(schema.mintJobs).where(eq(schema.mintJobs.status, "armed")).limit(500);
  for (const job of jobs) if (job.launchTargetAt) scheduleArmedTimers(job.id, job.launchTargetAt);
}

async function reconcileConfirmingWork(): Promise<void> {
  const jobs = await db.select({ id: schema.mintJobs.id }).from(schema.mintJobs)
    .where(eq(schema.mintJobs.status, "confirming")).limit(100);
  await Promise.allSettled(jobs.map((job) => recoverMintJob(job.id)));
}

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
  const armHorizon = new Date(Date.now() + armLeadMs()).toISOString();
  const liveEnabled = liveTransactionsEnabled();
  const candidates = await db.select().from(schema.mintJobs).where(
    and(
      eq(schema.mintJobs.status, "pending"),
      or(
        isNull(schema.mintJobs.scheduledAt),
        and(eq(schema.mintJobs.dryRun, true), lte(schema.mintJobs.scheduledAt, now)),
        and(eq(schema.mintJobs.dryRun, false), lte(schema.mintJobs.scheduledAt, liveEnabled ? armHorizon : now)),
      ),
      liveEnabled ? undefined : eq(schema.mintJobs.dryRun, true),
    ),
  ).orderBy(asc(schema.mintJobs.priority), asc(schema.mintJobs.scheduledAt), asc(schema.mintJobs.createdAt)).limit(maxConcurrent * 10);

  const runnable = firstTaskPerWallet(candidates);

  const running: Promise<unknown>[] = [];
  for (const job of runnable) {
    const claimToken = randomUUID();
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${job.walletId}`}))`);
      const [busy] = await tx.select({ id: schema.mintJobs.id }).from(schema.mintJobs).where(and(
        eq(schema.mintJobs.walletId, job.walletId),
        inArray(schema.mintJobs.status, ["running", "armed", "confirming"]),
      )).limit(1);
      if (busy) return [];
      return tx.update(schema.mintJobs).set({
        status: "running",
        claimToken,
        claimedAt: now,
        leaseExpiresAt: leaseExpiry(),
        startedAt: job.startedAt || now,
        updatedAt: now,
      }).where(and(eq(schema.mintJobs.id, job.id), eq(schema.mintJobs.status, "pending")))
        .returning({ id: schema.mintJobs.id });
    });
    if (!claimed.length) continue;
    running.push(runMintJob(job.id).then((result) => {
      if (result?.status === "armed" && result.launchTargetAt) scheduleArmedTimers(job.id, result.launchTargetAt);
    }).catch((error) => { state.lastError = safeErrorMessage(error); }));
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
  void recoverStaleWork()
    .catch((error) => { state.lastError = safeErrorMessage(error, "Scheduler recovery failed"); })
    .then(() => restoreArmedTimers())
    .catch((error) => { state.lastError = safeErrorMessage(error, "Armed timer recovery failed"); });
  void tick();
  state.schedulerInterval = setInterval(() => void tick(), SCHEDULER_INTERVAL_MS);
  state.recoveryInterval = setInterval(() => void recoverStaleWork(), RECOVERY_INTERVAL_MS);
  state.confirmationInterval = setInterval(() => void reconcileConfirmingWork(), CONFIRMATION_INTERVAL_MS);
  if (!state.signalHandlersRegistered) {
    state.signalHandlersRegistered = true;
    process.once("SIGTERM", stopScheduler);
    process.once("SIGINT", stopScheduler);
  }
}

export function stopScheduler(): void {
  if (state.schedulerInterval) clearInterval(state.schedulerInterval);
  if (state.recoveryInterval) clearInterval(state.recoveryInterval);
  if (state.confirmationInterval) clearInterval(state.confirmationInterval);
  for (const timer of state.launchTimers.values()) clearTimeout(timer);
  for (const timer of state.revalidationTimers.values()) clearTimeout(timer);
  state.launchTimers.clear();
  state.revalidationTimers.clear();
  state.schedulerInterval = null;
  state.recoveryInterval = null;
  state.confirmationInterval = null;
  state.tickRunning = false;
}

export function setSchedulerConcurrency(value: number): void {
  state.activeConcurrency = Math.max(1, Math.min(value, 20));
}

/** Redundant bootstrap/watchdog for the Railway probe and authenticated UI. */
export function ensureSchedulerRunning(): { restarted: boolean } {
  const running = Boolean(state.schedulerInterval);
  if (!running) {
    startScheduler();
    return { restarted: true };
  }
  if (!schedulerHeartbeatFresh(running, state.lastTickAt)) {
    stopScheduler();
    startScheduler();
    return { restarted: true };
  }
  return { restarted: false };
}

export function schedulerStatus() {
  const running = Boolean(state.schedulerInterval);
  return {
    running,
    healthy: schedulerHeartbeatFresh(running, state.lastTickAt),
    tickRunning: state.tickRunning,
    concurrency: state.activeConcurrency,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    armedTimers: state.launchTimers.size,
    pollIntervalMs: SCHEDULER_INTERVAL_MS,
  };
}
