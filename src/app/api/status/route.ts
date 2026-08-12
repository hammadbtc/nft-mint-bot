import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { checkRpcHealth, getChain } from "@/lib/chains";
import { schedulerStatus } from "@/lib/scheduler";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";

export async function GET() {
  try {
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
      .where(inArray(schema.mintJobs.status, ["pending", "running", "confirming"]))
      .groupBy(schema.mintJobs.status);
    const scheduler = schedulerStatus();
    const ready = scheduler.running && rpc.every((chain) => chain.healthy);
    return NextResponse.json({
      ready,
      liveTransactionsEnabled: liveTransactionsEnabled(),
      scheduler,
      rpc,
      jobs: Object.fromEntries(counts.map((item) => [item.status, item.count])),
    }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ready: false, error: safeErrorMessage(error, "Status check failed") }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
