import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  const requested = Number(req.nextUrl.searchParams.get("limit") || 50);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 200)) : 50;
  const rows = await db.select().from(schema.mintJobs)
    .where(status ? eq(schema.mintJobs.status, status) : undefined)
    .orderBy(desc(schema.mintJobs.createdAt)).limit(limit);
  const attempts = rows.length
    ? await db.select().from(schema.mintAttempts).where(inArray(schema.mintAttempts.jobId, rows.map((row) => row.id))).orderBy(desc(schema.mintAttempts.createdAt))
    : [];
  const broadcasts = attempts.length
    ? await db.select().from(schema.mintBroadcasts).where(inArray(schema.mintBroadcasts.attemptId, attempts.map((attempt) => attempt.id))).orderBy(desc(schema.mintBroadcasts.startedAt))
    : [];
  const broadcastsByAttempt = new Map<string, typeof broadcasts>();
  for (const broadcast of broadcasts) broadcastsByAttempt.set(broadcast.attemptId, [...(broadcastsByAttempt.get(broadcast.attemptId) || []), broadcast]);
  type AttemptWithBroadcasts = (typeof attempts)[number] & { rawTx: null; broadcasts: typeof broadcasts };
  const byJob = new Map<string, AttemptWithBroadcasts[]>();
  for (const attempt of attempts) byJob.set(attempt.jobId, [...(byJob.get(attempt.jobId) || []), { ...attempt, rawTx: null, broadcasts: broadcastsByAttempt.get(attempt.id) || [] }]);
  return NextResponse.json(rows.map((row) => ({ ...row, attempts: byJob.get(row.id) || [] })), { headers:{"Cache-Control":"no-store"} });
}
