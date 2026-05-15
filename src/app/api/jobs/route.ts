import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { runMintJob, batchMint } from "@/lib/engine/mint";
import { eq, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");

  const conditions = [];
  if (status) {
    conditions.push(eq(schema.mintJobs.status, status));
  }

  const rows = await db
    .select()
    .from(schema.mintJobs)
    .where(conditions.length ? conditions[0] : undefined)
    .orderBy(desc(schema.mintJobs.createdAt))
    .limit(limit);

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletId, collectionId, quantity, gasLimit, maxFeePerGas, maxPriorityFeePerGas, scheduledAt } = body;

    if (!walletId || !collectionId) {
      return NextResponse.json({ error: "walletId and collectionId are required" }, { status: 400 });
    }

    const jobId = uuidv4();

    await db.insert(schema.mintJobs).values({
      id: jobId,
      walletId,
      collectionId,
      quantity: quantity || 1,
      gasLimit: gasLimit?.toString(),
      maxFeePerGas: maxFeePerGas?.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(),
      scheduledAt: scheduledAt || null,
      status: "pending",
    });

    // If no schedule, execute immediately (async — don't block response)
    if (!scheduledAt) {
      // Fire and forget — the scheduler or immediate execution
      runMintJob(jobId).catch((err) => console.error(`Job ${jobId} failed:`, err));
    }

    const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, jobId)).limit(1);
    return NextResponse.json(job, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to create job" }, { status: 500 });
  }
}
