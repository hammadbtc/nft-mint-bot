import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { failArmedJob, launchArmedJob, leaseExpiry, recoverMintJob, revalidateArmedJob, runMintJob } from "@/lib/engine/mint";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";
import { processDisperseOperations, recoverDisperseOperation } from "@/lib/disperse";
import { armLeadMs, revalidateLeadMs, schedulePrecisely } from "@/lib/launch-timing";
import { firstTaskPerWallet } from "@/lib/task-management";
import { schedulerHeartbeatFresh, WORKER_HEARTBEAT_KEY } from "./health";
import { BlockWatcher, blockWatcherFresh, robinhoodWebSocketUrl } from "@/lib/chains/block-watcher";

const DEFAULT_MAX_CONCURRENT = 5;
const RECOVERY_INTERVAL_MS = 15_000;
const SCHEDULER_INTERVAL_MS = 250;
const DISPERSE_INTERVAL_MS = 250;
const CONFIRMATION_INTERVAL_MS = 1_000;

interface SchedulerRuntimeState {
  schedulerInterval: ReturnType<typeof setInterval> | null;
  disperseInterval: ReturnType<typeof setInterval> | null;
  recoveryInterval: ReturnType<typeof setInterval> | null;
  confirmationInterval: ReturnType<typeof setInterval> | null;
  workerHeartbeatInterval: ReturnType<typeof setInterval> | null;
  launchTimers: Map<string, ReturnType<typeof setTimeout>>;
  revalidationTimers: Map<string, ReturnType<typeof setTimeout>>;
  activeConcurrency: number;
  tickRunning: boolean;
  disperseTickRunning: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  disperseLastTickAt: string | null;
  disperseLastError: string | null;
  signalHandlersRegistered: boolean;
  blockWatcher: BlockWatcher | null;
}

// Next.js can bundle instrumentation and route handlers as separate module
// instances in the same Node process. Keep the scheduler state on `process`
// so every bundle observes and controls the same scheduler singleton.
const schedulerHost = process as NodeJS.Process & {
  __mintbotSchedulerRuntime?: SchedulerRuntimeState;
};
const state = schedulerHost.__mintbotSchedulerRuntime ??= {
  schedulerInterval: null,
  disperseInterval: null,
  recoveryInterval: null,
  confirmationInterval: null,
  workerHeartbeatInterval: null,
  launchTimers: new Map(),
  revalidationTimers: new Map(),
  activeConcurrency: DEFAULT_MAX_CONCURRENT,
  tickRunning: false,
  disperseTickRunning: false,
  lastTickAt: null,
  lastError: null,
  disperseLastTickAt: null,
  disperseLastError: null,
  signalHandlersRegistered: false,
  blockWatcher: null,
};
state.confirmationInterval ??= null;
state.workerHeartbeatInterval ??= null;
state.disperseInterval ??= null;
state.disperseTickRunning ??= false;
state.disperseLastTickAt ??= null;
state.disperseLastError ??= null;
state.launchTimers ??= new Map();
state.revalidationTimers ??= new Map();
state.blockWatcher ??= null;

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
    await processScheduledJobs();
    state.lastError = null;
  } catch (error) {
    state.lastError = safeErrorMessage(error, "Scheduler tick failed");
  } finally {
    state.tickRunning = false;
  }
}

async function persistWorkerHeartbeat(): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(schema.settings).values({ key: WORKER_HEARTBEAT_KEY, value: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: now, updatedAt: now } });
}

/** Funding and sweep work has its own scheduling lane. A slow receipt, RPC,
 * or wallet in Disperse must never prevent the 250ms mint detector from
 * ticking, and a launch storm must never make a queued funding operation
 * disappear behind mint concurrency. */
async function disperseTick(): Promise<void> {
  if (state.disperseTickRunning) return;
  state.disperseTickRunning = true;
  state.disperseLastTickAt = new Date().toISOString();
  try {
    await processDisperseOperations(Math.max(1, Math.floor(state.activeConcurrency / 2)));
    state.disperseLastError = null;
  } catch (error) {
    state.disperseLastError = safeErrorMessage(error, "Disperse scheduler tick failed");
  } finally {
    state.disperseTickRunning = false;
  }
}

export function startScheduler(): void {
  if (state.schedulerInterval && state.disperseInterval && state.workerHeartbeatInterval) return;
  if (state.schedulerInterval) clearInterval(state.schedulerInterval);
  if (state.disperseInterval) clearInterval(state.disperseInterval);
  void recoverStaleWork()
    .catch((error) => { state.lastError = safeErrorMessage(error, "Scheduler recovery failed"); })
    .then(() => restoreArmedTimers())
    .catch((error) => { state.lastError = safeErrorMessage(error, "Armed timer recovery failed"); });
  void tick();
  void disperseTick();
  state.schedulerInterval = setInterval(() => void tick(), SCHEDULER_INTERVAL_MS);
  state.disperseInterval = setInterval(() => void disperseTick(), DISPERSE_INTERVAL_MS);
  state.blockWatcher ||= new BlockWatcher(robinhoodWebSocketUrl(), () => { void tick(); });
  state.blockWatcher.start();
  state.recoveryInterval = setInterval(() => void recoverStaleWork(), RECOVERY_INTERVAL_MS);
  state.confirmationInterval = setInterval(() => void reconcileConfirmingWork(), CONFIRMATION_INTERVAL_MS);
  void persistWorkerHeartbeat().catch((error) => { state.lastError = safeErrorMessage(error, "Worker heartbeat failed"); });
  state.workerHeartbeatInterval = setInterval(() => {
    void persistWorkerHeartbeat().catch((error) => { state.lastError = safeErrorMessage(error, "Worker heartbeat failed"); });
  }, 5_000);
  if (!state.signalHandlersRegistered) {
    state.signalHandlersRegistered = true;
    process.once("SIGTERM", stopScheduler);
    process.once("SIGINT", stopScheduler);
  }
}

export function stopScheduler(): void {
  if (state.schedulerInterval) clearInterval(state.schedulerInterval);
  if (state.disperseInterval) clearInterval(state.disperseInterval);
  if (state.recoveryInterval) clearInterval(state.recoveryInterval);
  if (state.confirmationInterval) clearInterval(state.confirmationInterval);
  if (state.workerHeartbeatInterval) clearInterval(state.workerHeartbeatInterval);
  state.blockWatcher?.stop();
  for (const timer of state.launchTimers.values()) clearTimeout(timer);
  for (const timer of state.revalidationTimers.values()) clearTimeout(timer);
  state.launchTimers.clear();
  state.revalidationTimers.clear();
  state.schedulerInterval = null;
  state.disperseInterval = null;
  state.recoveryInterval = null;
  state.confirmationInterval = null;
  state.workerHeartbeatInterval = null;
  state.tickRunning = false;
  state.disperseTickRunning = false;
}

export function setSchedulerConcurrency(value: number): void {
  state.activeConcurrency = Math.max(1, Math.min(value, 20));
}

/** Redundant bootstrap/watchdog for the Railway probe and authenticated UI. */
export function ensureSchedulerRunning(): { restarted: boolean } {
  const mintRunning = Boolean(state.schedulerInterval);
  const disperseRunning = Boolean(state.disperseInterval);
  const heartbeatRunning = Boolean(state.workerHeartbeatInterval);
  if (!mintRunning || !disperseRunning || !heartbeatRunning) {
    startScheduler();
    return { restarted: true };
  }
  if (!schedulerHeartbeatFresh(mintRunning, state.lastTickAt) || !schedulerHeartbeatFresh(disperseRunning, state.disperseLastTickAt)) {
    stopScheduler();
    startScheduler();
    return { restarted: true };
  }
  return { restarted: false };
}

export function schedulerStatus() {
  const running = Boolean(state.schedulerInterval);
  const disperseRunning = Boolean(state.disperseInterval);
  const watcher = state.blockWatcher?.status() || { configured: false, connected: false, lastBlockAt: null, lastBlockNumber: null, lastError: null, reconnects: 0 };
  return {
    running,
    healthy: schedulerHeartbeatFresh(running, state.lastTickAt) && schedulerHeartbeatFresh(disperseRunning, state.disperseLastTickAt) && blockWatcherFresh(watcher),
    tickRunning: state.tickRunning,
    disperseRunning,
    disperseTickRunning: state.disperseTickRunning,
    concurrency: state.activeConcurrency,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    disperseLastTickAt: state.disperseLastTickAt,
    disperseLastError: state.disperseLastError,
    armedTimers: state.launchTimers.size,
    pollIntervalMs: SCHEDULER_INTERVAL_MS,
    dispersePollIntervalMs: DISPERSE_INTERVAL_MS,
    blockWatcher: { ...watcher, healthy: blockWatcherFresh(watcher) },
  };
}
