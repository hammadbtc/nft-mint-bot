import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET() {
  const [walletCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.wallets);
  const [collectionCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.collections);

  const [jobStats] = await db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${schema.mintJobs.status} = 'completed' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${schema.mintJobs.status} = 'failed' then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${schema.mintJobs.status} = 'pending' then 1 else 0 end)`,
      running: sql<number>`sum(case when ${schema.mintJobs.status} = 'running' then 1 else 0 end)`,
      dryRuns: sql<number>`sum(case when ${schema.mintJobs.dryRun} = true then 1 else 0 end)`,
      flashbots: sql<number>`sum(case when ${schema.mintJobs.useFlashbots} = true then 1 else 0 end)`,
    })
    .from(schema.mintJobs);

  const [alertCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.alertLog);

  const recentJobs = await db
    .select()
    .from(schema.mintJobs)
    .orderBy(sql`${schema.mintJobs.createdAt} desc`)
    .limit(10);

  return NextResponse.json({
    wallets: walletCount?.count || 0,
    collections: collectionCount?.count || 0,
    alerts: alertCount?.count || 0,
    jobs: {
      total: jobStats?.total || 0,
      completed: jobStats?.completed || 0,
      failed: jobStats?.failed || 0,
      pending: jobStats?.pending || 0,
      running: jobStats?.running || 0,
      dryRuns: jobStats?.dryRuns || 0,
      flashbots: jobStats?.flashbots || 0,
    },
    recentActivity: recentJobs,
  });
}
