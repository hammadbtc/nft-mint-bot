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
    const activeCollections = await db.selectDistinct({ chainId: schema.collections.chainId })
      .from(schema.collections)
      .where(and(
        eq(schema.collections.active, true),
        eq(schema.collections.verified, true),
        eq(schema.collections.broadcastPaused, false),
      ));
    const rpcChecks = await Promise.all(activeCollections.map(async ({ chainId }) => {
      const endpoints = await checkRpcHealth(chainId);
      const healthyRoutes = endpoints.filter((endpoint) => endpoint.status === "up").length;
      const requiredRoutes = liveTransactionsEnabled() ? 2 : 1;
      return healthyRoutes >= requiredRoutes;
    }));
    const rpcHealthy = rpcChecks.every(Boolean);
    const unarmedImminentJobs = unarmed?.count || 0;
    const configuredWebSockets = runsExecutionWorker(role) ? scheduler.blockWatcher.configuredProviders : runtime?.blockWatcherConfiguredProviders || 0;
    const webSocketRedundancyHealthy = !liveTransactionsEnabled() || configuredWebSockets >= 2;
    const foundationRows = await db.execute(sql<{ unpinned_jobs: number; uncertified_active_definitions: number }>`
      select
        (select count(*)::int from mint_jobs
          where status in ('pending','armed','running','confirming')
            and (definition_version_id is null or definition_hash is null or definition_snapshot is null)) as unpinned_jobs,
        (select count(*)::int from mint_definition_versions v
          join collections c0 on c0.id = v.collection_id
          where v.status = 'active' and c0.broadcast_paused = false and not exists (
            select 1 from mint_certifications c
            where c.definition_version_id = v.id and c.definition_hash = v.definition_hash
              and c.status = 'passed' and c.runner_version = 'mint-certifier-v1'
              and c.expires_at::timestamptz > now()
          )) as uncertified_active_definitions
    `);
    const foundation = Array.from(foundationRows)[0] || { unpinned_jobs: 0, uncertified_active_definitions: 0 };
    const certificationAttestationConfigured = (process.env.CERTIFICATION_ATTESTATION_KEY?.length || 0) >= 32;
    const foundationHealthy = Number(foundation.unpinned_jobs) === 0
      && Number(foundation.uncertified_active_definitions) === 0
      && certificationAttestationConfigured;
    const healthy = foundationHealthy && executionHealthy && missingLaunchTimers === 0 && unarmedImminentJobs === 0 && rpcHealthy && webSocketRedundancyHealthy;
    // Public probes expose only the deployment identity and aggregate result.
    // Authenticated operators use /api/status for diagnostics.
    void watchdog;
    return NextResponse.json(
      { status: healthy ? "ok" : "error", service: "mintbot", version: deploymentVersion() },
      { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "error", service: "mintbot", version: deploymentVersion() }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
