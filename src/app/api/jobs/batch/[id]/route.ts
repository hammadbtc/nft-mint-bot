import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requireAdminPassword } from "@/lib/admin-auth";
import { db, schema } from "@/lib/db";
import { safeErrorMessage } from "@/lib/safety";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    requireAdminPassword(req);
    const { id } = await params;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-batch-delete:${id}`}))`);
      const selector = or(
        eq(schema.mintJobs.batchId, id),
        and(isNull(schema.mintJobs.batchId), eq(schema.mintJobs.id, id)),
      );
      const initial = await tx.select().from(schema.mintJobs).where(selector);
      if (!initial.length) throw new Error("Scheduled mint was not found");

      for (const walletId of [...new Set(initial.map((job) => job.walletId))].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${walletId}`}))`);
      }
      const jobs = await tx.select().from(schema.mintJobs).where(selector);
      if (jobs.length !== initial.length) throw new Error("Schedule changed while deletion was being checked; retry");
      if (jobs.some((job) => !["pending", "failed"].includes(job.status))) {
        throw new Error("Whole schedule was not deleted because a task has started or completed");
      }
      const attempts = await tx.select({ id: schema.mintAttempts.id }).from(schema.mintAttempts)
        .where(inArray(schema.mintAttempts.jobId, jobs.map((job) => job.id))).limit(1);
      if (attempts.length) throw new Error("Whole schedule was not deleted because transaction history already exists");

      const deleted = await tx.delete(schema.mintJobs)
        .where(and(inArray(schema.mintJobs.id, jobs.map((job) => job.id)), inArray(schema.mintJobs.status, ["pending", "failed"])))
        .returning({ id: schema.mintJobs.id });
      if (deleted.length !== jobs.length) throw new Error("Whole schedule was not deleted because a task began processing");
      return deleted;
    });
    return NextResponse.json({ success: true, deletedCount: result.length }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not delete whole schedule") }, { status: 400, headers: noStore });
  }
}
