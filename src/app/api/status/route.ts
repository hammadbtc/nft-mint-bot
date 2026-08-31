import { NextResponse } from "next/server";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkRpcHealth, getChain } from "@/lib/chains";
import { ensureSchedulerRunning, schedulerStatus } from "@/lib/scheduler";
import { executionRole, runsExecutionWorker } from "@/lib/execution-role";
import { parseWorkerRuntimeHeartbeat, schedulerHeartbeatFresh, WORKER_HEARTBEAT_KEY } from "@/lib/scheduler/health";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";
import { deploymentVersion } from "@/lib/deployment";

export async function GET() {
  try {
    const role = executionRole();
    if (runsExecutionWorker(role)) ensureSchedulerRunning();
    const collections = await db.selectDistinct({ chainId: schema.collections.chainId })
      .from(schema.collections)
      .where(and(eq(schema.collections.active, true), eq(schema.collections.verified, true)));
    const chainIds = collections.map((item) => item.chainId);
    const rpc = await Promise.all(chainIds.map(async (chainId) => {
      const checks = await checkRpcHealth(chainId);
      return {
        chainId,
        name: getChain(chainId).name,
        healthy: checks.filter((item) => item.status === "up").length >= (liveTransactionsEnabled() ? 2 : 1),
        healthyRoutes: checks.filter((item) => item.status === "up").length,
        requiredHealthyRoutes: liveTransactionsEnabled() ? 2 : 1,
        endpoints: checks,
      };
    }));
    const counts = await db.select({ status: schema.mintJobs.status, count: sql<number>`count(*)::int` })
      .from(schema.mintJobs)
      .where(inArray(schema.mintJobs.status, ["pending", "armed", "running", "confirming"]))
      .groupBy(schema.mintJobs.status);
    const performanceRows = await db.execute(sql<{
      route_label: string;
      samples: number;
      p50_ms: number | null;
      p95_ms: number | null;
      p99_ms: number | null;
      accepted: number;
    }>`
      select route_label,
        count(*)::int as samples,
        (percentile_cont(0.50) within group (order by latency_ms))::int as p50_ms,
        (percentile_cont(0.95) within group (order by latency_ms))::int as p95_ms,
        (percentile_cont(0.99) within group (order by latency_ms))::int as p99_ms,
        count(*) filter (where status in ('accepted', 'known'))::int as accepted
      from mint_broadcasts
      where latency_ms is not null and started_at::timestamptz > now() - interval '24 hours'
      group by route_label
      order by p50_ms asc
    `);
    const scheduler = schedulerStatus();
    const [heartbeat] = await db.select({ value: schema.settings.value }).from(schema.settings)
      .where(eq(schema.settings.key, WORKER_HEARTBEAT_KEY)).limit(1);
    const runtime = parseWorkerRuntimeHeartbeat(heartbeat?.value);
    const executionHealthy = runsExecutionWorker(role) ? scheduler.healthy : schedulerHeartbeatFresh(true, heartbeat?.value || null) && runtime?.blockWatcherHealthy !== false;
    const armedJobs = counts.find((item) => item.status === "armed")?.count || 0;
    const armedTimers = runsExecutionWorker(role) ? scheduler.armedTimers : runtime?.armedTimers || 0;
    const missingLaunchTimers = Math.max(0, armedJobs - armedTimers);
    const imminentAt = new Date(Date.now() + 60_000).toISOString();
    const [unarmed] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.mintJobs).where(and(
      eq(schema.mintJobs.dryRun, false), inArray(schema.mintJobs.status, ["pending", "running"]), lte(schema.mintJobs.scheduledAt, imminentAt),
    ));
    const unarmedImminentJobs = unarmed?.count || 0;
    const configuredWebSockets = runsExecutionWorker(role) ? scheduler.blockWatcher.configuredProviders : runtime?.blockWatcherConfiguredProviders || 0;
    const webSocketRedundancyHealthy = !liveTransactionsEnabled() || configuredWebSockets >= 2;
    const stuck = await db.execute(sql<{ kind: string; count: number }>`
      select 'mint'::text as kind, count(*)::int as count from mint_jobs
      where status in ('running','confirming') and (lease_expires_at is null or lease_expires_at::timestamptz < now())
      union all
      select 'disperse'::text as kind, count(*)::int as count from disperse_operations
      where status in ('running','confirming') and (lease_expires_at is null or lease_expires_at::timestamptz < now())
    `);
    const stuckWork = Object.fromEntries(Array.from(stuck).map((item) => [item.kind, item.count]));
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
    const hardeningRows = await db.execute(sql<{
      legacy_active_collections: number; shadow_audits: number; ready_cutovers: number;
      completed_cutovers: number; shadow_mismatches: number; incident_bundles_24h: number;
    }>`
      select
        (select count(*)::int from collections where active and verified and adapter_key <> 'reviewed-call-v1') as legacy_active_collections,
        (select count(*)::int from mint_cutover_states where status = 'shadow') as shadow_audits,
        (select count(*)::int from mint_cutover_states where status = 'ready') as ready_cutovers,
        (select count(*)::int from mint_cutover_states where status = 'cutover') as completed_cutovers,
        (select count(*)::int from mint_shadow_comparisons where status = 'mismatch') as shadow_mismatches,
        (select count(*)::int from mint_incident_bundles where created_at::timestamptz > now() - interval '24 hours') as incident_bundles_24h
    `);
    const hardening = Array.from(hardeningRows)[0] || { legacy_active_collections: 0, shadow_audits: 0, ready_cutovers: 0, completed_cutovers: 0, shadow_mismatches: 0, incident_bundles_24h: 0 };
    const ready = foundationHealthy && executionHealthy && webSocketRedundancyHealthy && missingLaunchTimers === 0 && unarmedImminentJobs === 0 && Object.values(stuckWork).every((count) => Number(count) === 0) && rpc.every((chain) => chain.healthy);
    const broadcastRows = Array.from(performanceRows) as unknown as Array<{
      route_label: string; samples: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null; accepted: number;
    }>;
    const broadcastPerformance = broadcastRows.map((route) => ({
      ...route,
      healthy: Number(route.accepted) > 0 && Number(route.accepted) / Number(route.samples) >= 0.5,
    }));
    return NextResponse.json({
      ready,
      version: deploymentVersion(),
      liveTransactionsEnabled: liveTransactionsEnabled(),
      scheduler: {
        ...scheduler,
        role,
        running: runsExecutionWorker(role) ? scheduler.running : executionHealthy,
        healthy: executionHealthy,
        lastTickAt: runsExecutionWorker(role) ? scheduler.lastTickAt : runtime?.at || null,
        armedJobs,
        armedTimers,
        missingLaunchTimers,
        unarmedImminentJobs,
        blockWatcher: runsExecutionWorker(role) ? scheduler.blockWatcher : { healthy: runtime?.blockWatcherHealthy ?? false, intentionalIdle: runtime?.blockWatcherIntentionalIdle ?? false },
        webSocketRedundancyHealthy,
      },
      rpc,
      jobs: Object.fromEntries(counts.map((item) => [item.status, item.count])),
      broadcastPerformance,
      degradedBroadcastRoutes: broadcastPerformance.filter((route) => !route.healthy).map((route) => route.route_label),
      stuckWork,
      mintFoundation: {
        healthy: foundationHealthy,
        unpinnedJobs: Number(foundation.unpinned_jobs),
        uncertifiedActiveDefinitions: Number(foundation.uncertified_active_definitions),
        certificationAttestationConfigured,
      },
      competitiveHardening: {
        legacyActiveCollections: Number(hardening.legacy_active_collections),
        shadowAudits: Number(hardening.shadow_audits),
        readyCutovers: Number(hardening.ready_cutovers),
        completedCutovers: Number(hardening.completed_cutovers),
        shadowMismatches: Number(hardening.shadow_mismatches),
        incidentBundles24h: Number(hardening.incident_bundles_24h),
        migrationComplete: Number(hardening.legacy_active_collections) === 0,
      },
    }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ready: false, version: deploymentVersion(), error: safeErrorMessage(error, "Status check failed") }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
