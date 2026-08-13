import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { inspectWalletPhases, resolveWalletPhasePlan, resolveWalletSelectedPhase } from "@/lib/phase-planning";
import { mintWalletEligibilityError } from "@/lib/mint-wallet-policy";
import { requireAdminPassword } from "@/lib/admin-auth";
import { safeErrorMessage } from "@/lib/safety";
import { mintTaskMutationError } from "@/lib/task-management";
import { getMintAdapter } from "@/lib/adapters";
import { getProvider } from "@/lib/chains";
import { getSigner } from "@/lib/vault";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

const editSchema = z.object({
  walletId: z.string().uuid().optional(),
  phaseId: z.string().min(1).max(100).optional(),
  quantity: z.coerce.number().int().min(1).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0, "No valid task fields to update");

export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Mint task not found" }, { status: 404, headers: noStore });
    const [[collection], [wallet]] = await Promise.all([
      db.select().from(schema.collections).where(eq(schema.collections.id, job.collectionId)).limit(1),
      db.select().from(schema.wallets).where(eq(schema.wallets.id, job.walletId)).limit(1),
    ]);
    if (!collection?.active || !collection.verified || !wallet) throw new Error("Mint task configuration is unavailable");
    const adapter = getMintAdapter(collection.adapterKey);
    if (!adapter) throw new Error("The reviewed mint adapter is unavailable");
    const phases = (await adapter.resolve(collection, "name")).phases;
    const signer = adapter.requiresSignerForEligibility ? await getSigner(wallet.id, getProvider(collection.chainId)) : undefined;
    const plan = await inspectWalletPhases(collection, wallet.address, job.quantity, phases, { signer });
    return NextResponse.json({
      job: { id: job.id, collectionId: job.collectionId, walletId: job.walletId, phaseId: job.phaseId, quantity: job.quantity },
      phases: plan.phases.map((phase) => ({ ...phase, eligibility: plan.eligibility.find((item) => item.phaseId === phase.id) })),
    }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not load task editor") }, { status: 400, headers: noStore });
  }
}

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const input = editSchema.parse(await req.json());
    const [job] = await db.select().from(schema.mintJobs).where(eq(schema.mintJobs.id, id)).limit(1);
    if (!job) return NextResponse.json({ error: "Mint task not found" }, { status: 404, headers: noStore });
    if (job.status !== "pending") throw new Error(mintTaskMutationError(job.status, false) || "Task cannot be edited");

    const walletId = input.walletId || job.walletId;
    const phaseId = input.phaseId || job.phaseId;
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
    const signer = adapter.requiresSignerForEligibility ? await getSigner(wallet.id, getProvider(collection.chainId)) : undefined;
    const phase = phaseId
      ? (await resolveWalletSelectedPhase(collection, wallet.address, quantity, phaseId, undefined, { signer })).selectedPhase
      : (await resolveWalletPhasePlan(collection, wallet.address, quantity, undefined, { signer })).selectedPhase;
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
      if (fresh.batchId) {
        const [duplicate] = await tx.select({ id: schema.mintJobs.id }).from(schema.mintJobs).where(and(
          eq(schema.mintJobs.batchId, fresh.batchId),
          eq(schema.mintJobs.walletId, walletId),
          eq(schema.mintJobs.phaseId, phase.id),
          ne(schema.mintJobs.id, id),
        )).limit(1);
        if (duplicate) throw new Error("This batch already has a task for that wallet and phase");
      }
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
