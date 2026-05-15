import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { runMintJob } from "@/lib/engine/mint";

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

  // Also fetch attempts
  const attempts = await db
    .select()
    .from(schema.mintAttempts)
    .where(eq(schema.mintAttempts.jobId, id))
    .orderBy(schema.mintAttempts.createdAt);

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

    return NextResponse.json({ error: "Invalid action. Use 'retry' or 'cancel'." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
