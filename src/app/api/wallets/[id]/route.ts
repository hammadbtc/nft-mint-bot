import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { prepareWalletKeyReplacement } from "@/lib/vault";
import { safeErrorMessage } from "@/lib/safety";
import { requireAdminPassword } from "@/lib/admin-auth";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    requireAdminPassword(req);
    const { id } = await params;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${id}`}))`);
      const [wallet] = await tx.select().from(schema.wallets).where(eq(schema.wallets.id, id)).limit(1);
      if (!wallet) return null;
      const [child] = await tx.select({ id: schema.wallets.id }).from(schema.wallets)
        .where(eq(schema.wallets.parentWalletId, id)).limit(1);
      if (child) throw new Error("Remove this main wallet's workers first");
      const [activeJob] = await tx.select({ id: schema.mintJobs.id }).from(schema.mintJobs)
        .where(and(eq(schema.mintJobs.walletId, id), inArray(schema.mintJobs.status, ["pending", "running", "armed", "confirming"]))).limit(1);
      if (activeJob) throw new Error("Delete or finish this wallet's active mint task first");
      const [job] = await tx.select({ id: schema.mintJobs.id }).from(schema.mintJobs)
        .where(eq(schema.mintJobs.walletId, id)).limit(1);
      const [transfer] = await tx.select({ id: schema.disperseTransfers.id }).from(schema.disperseTransfers)
        .where(or(eq(schema.disperseTransfers.fromWalletId, id), eq(schema.disperseTransfers.toWalletId, id))).limit(1);
      if (job || transfer) {
        await tx.update(schema.wallets).set({ active: false, updatedAt: new Date().toISOString() }).where(eq(schema.wallets.id, id));
        return { deactivated: true };
      }
      await tx.delete(schema.walletNonceState).where(eq(schema.walletNonceState.walletId, id));
      await tx.delete(schema.wallets).where(eq(schema.wallets.id, id));
      return { deactivated: false };
    });
    if (!result) return NextResponse.json({ error: "Wallet not found" }, { status: 404, headers: noStore });
    return NextResponse.json({ success: true, ...result, ...(result.deactivated ? { reason: "Audit history retained" } : {}) }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not remove wallet") }, { status: 400, headers: noStore });
  }
}

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const input = z.object({
      label: z.string().trim().min(1).max(80).optional(),
      active: z.boolean().optional(),
      replacement: z.object({
        keyType: z.enum(["private-key", "mnemonic"]),
        key: z.string().trim().min(1),
        hdPath: z.string().trim().optional(),
      }).optional(),
    })
      .refine((value) => Object.keys(value).length > 0, "No valid fields to update")
      .parse(await req.json());
    const [current] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).limit(1);
    if (!current) return NextResponse.json({ error: "Wallet not found" }, { status: 404, headers: noStore });
    if (input.active === false && current.role === "main") {
      const activeChildren = await db.select({ id: schema.wallets.id }).from(schema.wallets)
        .where(and(eq(schema.wallets.parentWalletId, id), eq(schema.wallets.active, true))).limit(1);
      if (activeChildren.length) throw new Error("Deactivate this main wallet's active workers first");
    }
    if (input.active === true && current.role === "worker") {
      const [parent] = await db.select({ active: schema.wallets.active, role: schema.wallets.role }).from(schema.wallets)
        .where(eq(schema.wallets.id, current.parentWalletId || "")).limit(1);
      if (!parent?.active || parent.role !== "main") throw new Error("Activate the worker's main wallet first");
    }
    let replacement: ReturnType<typeof prepareWalletKeyReplacement> | undefined;
    if (input.replacement) {
      requireAdminPassword(req);
      if (input.replacement.keyType === "mnemonic") {
        const words = input.replacement.key.split(/\s+/);
        if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error("Seed phrase must contain 12, 15, 18, 21, or 24 words");
      }
      replacement = prepareWalletKeyReplacement(input.replacement);
    }
    const ordinary = { label: input.label, active: input.active };
    await db.transaction(async (tx) => {
      if (replacement || input.active === false) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-schedule:${id}`}))`);
      }
      if (input.active === false) {
        const [activeJob] = await tx.select({ id: schema.mintJobs.id }).from(schema.mintJobs)
          .where(and(eq(schema.mintJobs.walletId, id), inArray(schema.mintJobs.status, ["pending", "running", "armed", "confirming"]))).limit(1);
        if (activeJob) throw new Error("Delete or finish this wallet's active mint task before deactivating it");
      }
      if (replacement) {
        const [[jobHistory], [transferHistory]] = await Promise.all([
          tx.select({ id: schema.mintJobs.id }).from(schema.mintJobs).where(eq(schema.mintJobs.walletId, id)).limit(1),
          tx.select({ id: schema.disperseTransfers.id }).from(schema.disperseTransfers)
            .where(or(eq(schema.disperseTransfers.fromWalletId, id), eq(schema.disperseTransfers.toWalletId, id))).limit(1),
        ]);
        if (jobHistory || transferHistory) throw new Error("This wallet has audit history. Import the replacement as a new wallet and deactivate this one instead");
        await tx.delete(schema.walletNonceState).where(eq(schema.walletNonceState.walletId, id));
      }
      await tx.update(schema.wallets).set({ ...ordinary, ...replacement, updatedAt: new Date().toISOString() }).where(eq(schema.wallets.id, id));
    });
    const [wallet] = await db.select({
      id: schema.wallets.id, label: schema.wallets.label, address: schema.wallets.address, chainId: schema.wallets.chainId,
      keyFormat: schema.wallets.keyFormat, active: schema.wallets.active, role: schema.wallets.role,
      parentWalletId: schema.wallets.parentWalletId, createdAt: schema.wallets.createdAt,
    }).from(schema.wallets).where(eq(schema.wallets.id, id)).limit(1);
    return NextResponse.json(wallet, { headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not update wallet");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
