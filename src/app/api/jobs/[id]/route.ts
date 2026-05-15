import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { runMintJob, unstickJob } from "@/lib/engine/mint";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [job] = await db
    .select()
    .from(schema.mintJobs)
    .where(eq(schema.mintJobs.id, id))
    .limit(1);

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const attempts = await db
    .select()
    .from(schema.mintAttempts)
    .where(eq(schema.mintAttempts.jobId, id))
    .orderBy(desc(schema.mintAttempts.createdAt));

  return NextResponse.json({ ...job, attempts });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const action = body.action;

    if (action === "retry") {
      const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

      await db
        .update(schema.mintJobs)
        .set({ status: "pending", retryCount: 0, error: null })
        .where(eq(schema.mintJobs.id, id));

      runMintJob(id).catch((err) => console.error(`Retry job ${id} failed:`, err));

      const [updated] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      return NextResponse.json(updated);
    }

    if (action === "cancel") {
      await db
        .update(schema.mintJobs)
        .set({ status: "cancelled", completedAt: new Date().toISOString() })
        .where(eq(schema.mintJobs.id, id));

      const [updated] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      return NextResponse.json(updated);
    }

    if (action === "unstuck") {
      const result = await unstickJob(id);
      return NextResponse.json(result);
    }

    if (action === "speedup") {
      // Speed up: retry with higher gas
      const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

      // Re-queue with higher gas
      await db
        .update(schema.mintJobs)
        .set({ status: "pending", retryCount: 0, error: null })
        .where(eq(schema.mintJobs.id, id));

      runMintJob(id).catch((err) => console.error(`Speedup job ${id} failed:`, err));

      const [updated] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "Invalid action. Use 'retry', 'cancel', 'unstuck', or 'speedup'." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
