import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkRpcHealth, getChain } from "@/lib/chains";
import { ensureSchedulerRunning, schedulerStatus } from "@/lib/scheduler";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";

export async function GET() {
  try {
    ensureSchedulerRunning();
    const collections = await db.selectDistinct({ chainId: schema.collections.chainId })
      .from(schema.collections)
      .where(and(eq(schema.collections.active, true), eq(schema.collections.verified, true)));
    const chainIds = collections.map((item) => item.chainId);
    const rpc = await Promise.all(chainIds.map(async (chainId) => {
      const checks = await checkRpcHealth(chainId);
      return {
        chainId,
        name: getChain(chainId).name,
        healthy: checks.some((item) => item.status === "up"),
        endpoints: checks.map((item) => ({ status: item.status, latencyMs: item.latencyMs })),
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
      where latency_ms is not null
      group by route_label
      order by p50_ms asc
    `);
    const scheduler = schedulerStatus();
    const ready = scheduler.healthy && rpc.every((chain) => chain.healthy);
    return NextResponse.json({
      ready,
      liveTransactionsEnabled: liveTransactionsEnabled(),
      scheduler,
      rpc,
      jobs: Object.fromEntries(counts.map((item) => [item.status, item.count])),
      broadcastPerformance: Array.from(performanceRows),
    }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ready: false, error: safeErrorMessage(error, "Status check failed") }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
