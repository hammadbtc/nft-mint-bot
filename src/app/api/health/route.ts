import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { ensureSchedulerRunning, schedulerStatus } from "@/lib/scheduler";
import { executionRole, runsExecutionWorker } from "@/lib/execution-role";
import { schedulerHeartbeatFresh, WORKER_HEARTBEAT_KEY } from "@/lib/scheduler/health";
import { liveTransactionsEnabled } from "@/lib/safety";
import { deploymentVersion } from "@/lib/deployment";

export async function GET() {
  try {
    // This probe is also a redundant worker bootstrap/watchdog. A connected
    // database alone must never make a dead mint scheduler look healthy.
    const role = executionRole();
    const watchdog = runsExecutionWorker(role) ? ensureSchedulerRunning() : { restarted: false };
    await db.execute(sql`select 1`);
    const scheduler = schedulerStatus();
    const [heartbeat] = await db.select({ value: schema.settings.value }).from(schema.settings)
      .where(eq(schema.settings.key, WORKER_HEARTBEAT_KEY)).limit(1);
    const executionHealthy = runsExecutionWorker(role) ? scheduler.healthy : schedulerHeartbeatFresh(true, heartbeat?.value || null);
    return NextResponse.json(
      {
        status: executionHealthy ? "ok" : "error",
        db: "connected",
        service: "mintbot",
        version: deploymentVersion(),
        liveTransactionsEnabled: liveTransactionsEnabled(),
        scheduler: {
          role,
          running: runsExecutionWorker(role) ? scheduler.running : executionHealthy,
          healthy: executionHealthy,
          lastTickAt: runsExecutionWorker(role) ? scheduler.lastTickAt : heartbeat?.value || null,
          lastError: scheduler.lastError,
          restartedByWatchdog: watchdog.restarted,
        },
      },
      { status: executionHealthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "error", db: "disconnected", service: "mintbot", version: deploymentVersion() }, { status: 503 });
  }
}
