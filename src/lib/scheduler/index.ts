import { db, schema } from "@/lib/db";
import { runMintJob } from "@/lib/engine/mint";
import { eq, and, lt, or, isNull } from "drizzle-orm";

/**
 * Check for pending jobs that are scheduled to run now and execute them.
 * Called by a setInterval loop or cron.
 */
export async function processScheduledJobs(): Promise<number> {
  const now = new Date().toISOString();

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
    .limit(10); // Process up to 10 at a time

  let processed = 0;
  for (const job of pendingJobs) {
    try {
      await runMintJob(job.id);
      processed++;
    } catch (err) {
      console.error(`Job ${job.id} failed:`, err);
    }
  }

  return processed;
}

/**
 * Start the scheduler loop. Runs every 2 seconds to check for pending jobs.
 * Only start in server environment (not during build).
 */
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  if (schedulerInterval) return;
  console.log("🔄 Mint scheduler started (2s interval)");
  schedulerInterval = setInterval(async () => {
    try {
      const count = await processScheduledJobs();
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
