import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { deleteWallet } from "@/lib/vault";
import { safeErrorMessage } from "@/lib/safety";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

export async function DELETE(_req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).limit(1);
    if (!wallet) return NextResponse.json({ error: "Wallet not found" }, { status: 404, headers: noStore });
    const children = await db.select({ id: schema.wallets.id }).from(schema.wallets)
      .where(eq(schema.wallets.parentWalletId, id)).limit(1);
    if (children.length) throw new Error("Remove or deactivate this main wallet's workers first");
    const [job] = await db.select({ id: schema.mintJobs.id }).from(schema.mintJobs)
      .where(eq(schema.mintJobs.walletId, id)).limit(1);
    const [transfer] = await db.select({ id: schema.disperseTransfers.id }).from(schema.disperseTransfers)
      .where(or(eq(schema.disperseTransfers.fromWalletId, id), eq(schema.disperseTransfers.toWalletId, id))).limit(1);
    if (job || transfer) {
      await db.update(schema.wallets).set({ active: false, updatedAt: new Date().toISOString() }).where(eq(schema.wallets.id, id));
      return NextResponse.json({ success: true, deactivated: true, reason: "Audit history retained" }, { headers: noStore });
    }
    await deleteWallet(id);
    return NextResponse.json({ success: true, deactivated: false }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not remove wallet") }, { status: 400, headers: noStore });
  }
}

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const input = z.object({ label: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() })
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
    await db.update(schema.wallets).set({ ...input, updatedAt: new Date().toISOString() }).where(eq(schema.wallets.id, id));
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
