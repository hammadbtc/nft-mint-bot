import { db, schema } from "@/lib/db";
import { runMintJob } from "@/lib/engine/mint";
import { eq, and, lt, or, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

const DEFAULT_MAX_CONCURRENT = 5;

/**
 * Check for pending jobs that are scheduled to run now and execute them.
 */
export async function processScheduledJobs(maxConcurrent?: number): Promise<number> {
  const now = new Date().toISOString();
  const limit = maxConcurrent || DEFAULT_MAX_CONCURRENT;

  const pendingJobs = await db
    .select()
    .from(schema.mintJobs)
    .where(
      and(
        eq(schema.mintJobs.status, "pending"),
        or(
          isNull(schema.mintJobs.scheduledAt),
          lt(schema.mintJobs.scheduledAt, now)
        )
      )
    )
    .orderBy(schema.mintJobs.priority)
    .limit(limit * 2); // fetch double to account for running slots

  if (pendingJobs.length === 0) return 0;

  // Run jobs concurrently (up to limit)
  let processed = 0;
  const running: Promise<void>[] = [];

  for (const job of pendingJobs) {
    const claimToken = randomUUID();
    // Mark as running to prevent double-pick (optimistic lock via WHERE status='pending')
    const updated = await db
      .update(schema.mintJobs)
      .set({ status: "running", startedAt: new Date().toISOString(), claimedAt:new Date().toISOString(), claimToken })
      .where(
        and(
          eq(schema.mintJobs.id, job.id),
          eq(schema.mintJobs.status, "pending")
        )
      )
      .returning({ id: schema.mintJobs.id });

    if (updated.length === 0) continue; // another worker grabbed it

    const promise = runMintJob(job.id)
      .then(() => { processed++; })
      .catch((err) => {
        console.error(`Job ${job.id} failed:`, err);
        processed++;
      });

    running.push(promise);

    if (running.length >= limit) {
      // Wait for at least one to finish
      await Promise.race(
        running.map((p, i) => p.then(() => i).catch(() => i))
      );
      // Remove all completed promises
      for (let i = running.length - 1; i >= 0; i--) {
        const p = running[i];
        const done = await Promise.race([
          p.then(() => true).catch(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 10)),
        ]);
        if (done) running.splice(i, 1);
      }
    }
  }

  // Wait for remaining
  await Promise.allSettled(running);
  return processed;
}

// ─── Scheduler ─────────────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let activeConcurrency = DEFAULT_MAX_CONCURRENT;

export function startScheduler() {
  if (schedulerInterval) return;
  console.log(`🔄 Mint scheduler started (2s interval, ${activeConcurrency} workers)`);
  schedulerInterval = setInterval(async () => {
    try {
      const count = await processScheduledJobs(activeConcurrency);
      if (count > 0) {
        console.log(`✅ Processed ${count} mint jobs`);
      }
    } catch (err) {
      console.error("Scheduler error:", err);
    }
  }, 2000);
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

export function setSchedulerConcurrency(n: number) {
  activeConcurrency = Math.max(1, Math.min(n, 20));
  console.log(`Scheduler concurrency set to ${activeConcurrency}`);
}
