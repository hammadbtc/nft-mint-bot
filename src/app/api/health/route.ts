import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { ensureSchedulerRunning, schedulerStatus } from "@/lib/scheduler";
import { executionRole, runsExecutionWorker } from "@/lib/execution-role";
import { parseWorkerRuntimeHeartbeat, schedulerHeartbeatFresh, WORKER_HEARTBEAT_KEY } from "@/lib/scheduler/health";
import { liveTransactionsEnabled } from "@/lib/safety";
import { deploymentVersion } from "@/lib/deployment";
import { checkRpcHealth } from "@/lib/chains";

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
    const runtime = parseWorkerRuntimeHeartbeat(heartbeat?.value);
    const executionHealthy = runsExecutionWorker(role) ? scheduler.healthy : schedulerHeartbeatFresh(true, heartbeat?.value || null) && runtime?.blockWatcherHealthy !== false;
    const [armed] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.mintJobs).where(eq(schema.mintJobs.status, "armed"));
    const imminentAt = new Date(Date.now() + 60_000).toISOString();
    const [unarmed] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.mintJobs).where(and(
      eq(schema.mintJobs.dryRun, false), inArray(schema.mintJobs.status, ["pending", "running"]), lte(schema.mintJobs.scheduledAt, imminentAt),
    ));
    const armedTimers = runsExecutionWorker(role) ? scheduler.armedTimers : runtime?.armedTimers || 0;
    const missingLaunchTimers = Math.max(0, (armed?.count || 0) - armedTimers);
    const rpcEndpoints = await checkRpcHealth(4663);
    const rpcHealthy = rpcEndpoints.some((endpoint) => endpoint.status === "up");
    const unarmedImminentJobs = unarmed?.count || 0;
    const healthy = executionHealthy && missingLaunchTimers === 0 && unarmedImminentJobs === 0 && rpcHealthy;
    return NextResponse.json(
      {
        status: healthy ? "ok" : "error",
        db: "connected",
        service: "mintbot",
        version: deploymentVersion(),
        liveTransactionsEnabled: liveTransactionsEnabled(),
        rpc: { chainId: 4663, healthy: rpcHealthy, endpoints: rpcEndpoints },
        scheduler: {
          role,
          running: runsExecutionWorker(role) ? scheduler.running : executionHealthy,
          healthy,
          lastTickAt: runsExecutionWorker(role) ? scheduler.lastTickAt : runtime?.at || null,
          lastError: scheduler.lastError,
          restartedByWatchdog: watchdog.restarted,
          armedJobs: armed?.count || 0,
          armedTimers,
          missingLaunchTimers,
          unarmedImminentJobs,
          blockWatcher: runsExecutionWorker(role) ? scheduler.blockWatcher : { healthy: runtime?.blockWatcherHealthy ?? false },
        },
      },
      { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "error", db: "disconnected", service: "mintbot", version: deploymentVersion() }, { status: 503 });
  }
}
