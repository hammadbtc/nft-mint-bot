import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { getMintAdapter } from "@/lib/adapters";
import { selectExecutionPhase } from "@/lib/mint-policy";
import { mintWalletEligibilityError } from "@/lib/mint-wallet-policy";
import { requireAdminPassword } from "@/lib/admin-auth";
import { safeErrorMessage } from "@/lib/safety";
import { mintTaskMutationError } from "@/lib/task-management";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

const editSchema = z.object({
  walletId: z.string().uuid().optional(),
  quantity: z.coerce.number().int().min(1).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0, "No valid task fields to update");

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const input = editSchema.parse(await req.json());
    const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Mint task not found" }, { status: 404, headers: noStore });
    if (job.status !== "pending") throw new Error(mintTaskMutationError(job.status, false) || "Task cannot be edited");

    const walletId = input.walletId || job.walletId;
    const quantity = input.quantity || job.quantity;
    const [[collection], [wallet]] = await Promise.all([
      db.select().from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1),
      db.select().from(schema.wallets).where(eq(schema.wallets.id, walletId)).limit(1),
    ]);
    if (!collection?.active || !collection.verified) throw new Error("Mint support is disabled or no longer verified");
    if (!wallet) throw new Error("Selected wallet was not found");
    const [parent] = wallet.role === "worker" && wallet.parentWalletId
      ? await db.select().from(schema.wallets).where(eq(schema.wallets.id, wallet.parentWalletId)).limit(1)
      : [];
    const eligibilityError = mintWalletEligibilityError(wallet, collection.chainId, parent);
    if (eligibilityError) throw new Error(eligibilityError);
    const adapter = getMintAdapter(collection.adapterKey);
    if (!adapter) throw new Error("The reviewed mint adapter is unavailable");
    const phase = selectExecutionPhase((await adapter.resolve(collection, "name")).phases);
    if (quantity > (phase.maxPerWallet || collection.maxPerWallet || 100)) throw new Error("Quantity exceeds the reviewed transaction limit");

    const scheduledAt = phase.status === "upcoming" ? phase.startsAt || null : null;
    const updated = await db.transaction(async (tx) => {
      for (const lockWalletId of [...new Set([job.walletId, walletId])].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${lockWalletId}`}))`);
      }
      const [fresh] = await tx.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      if (!fresh || fresh.status !== "pending") throw new Error("Task began processing while it was being edited");
      const [attempt] = await tx.select({ id: schema.mintAttempts.id }).from(schema.mintAttempts)
        .where(eq(schema.mintAttempts.jobId, id)).limit(1);
      const mutationError = mintTaskMutationError(fresh.status, Boolean(attempt));
      if (mutationError) throw new Error(mutationError);
      return tx.update(schema.mintJobs).set({
        walletId,
        quantity,
        scheduledAt,
        phaseId: phase.id,
        phaseStartsAt: phase.startsAt || null,
        phaseEndsAt: phase.endsAt || null,
        updatedAt: new Date().toISOString(),
        error: null,
      })
        .where(and(eq(schema.mintJobs.id, id), eq(schema.mintJobs.status, "pending")))
        .returning();
    });
    if (!updated.length) throw new Error("Task could not be updated before processing began");
    return NextResponse.json(updated[0], { headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not update mint task");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    requireAdminPassword(req);
    const { id } = await params;
    const deleted = await db.transaction(async (tx) => {
      const [job] = await tx.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
      if (!job) return [];
      if (job.status !== "pending") throw new Error(mintTaskMutationError(job.status, false) || "Task cannot be deleted");
      const [attempt] = await tx.select({ id: schema.mintAttempts.id }).from(schema.mintAttempts)
        .where(eq(schema.mintAttempts.jobId, id)).limit(1);
      const mutationError = mintTaskMutationError(job.status, Boolean(attempt));
      if (mutationError) throw new Error(mutationError);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${job.walletId}`}))`);
      return tx.delete(schema.mintJobs).where(and(eq(schema.mintJobs.id, id), eq(schema.mintJobs.status, "pending"))).returning({ id: schema.mintJobs.id });
    });
    if (!deleted.length) return NextResponse.json({ error: "Mint task was not found or has already started" }, { status: 404, headers: noStore });
    return NextResponse.json({ success: true, deleted: true }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not delete mint task") }, { status: 400, headers: noStore });
  }
}
