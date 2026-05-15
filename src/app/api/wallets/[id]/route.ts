import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { deleteWallet } from "@/lib/vault";
import { eq } from "drizzle-orm";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteWallet(id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    const updates: Record<string, any> = {};

    if (body.label !== undefined) updates.label = body.label;
    if (body.spendLimit !== undefined) {
      // Accept ETH string and convert to wei
      if (body.spendLimit === "" || body.spendLimit === null) {
        updates.spendLimit = null;
      } else {
        const { ethers } = await import("ethers");
        updates.spendLimit = ethers.parseEther(body.spendLimit).toString();
      }
    }
    if (body.active !== undefined) updates.active = body.active;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    await db
      .update(schema.wallets)
      .set(updates)
      .where(eq(schema.wallets.id, id));

    // Fetch updated wallet (without key)
    const [wallet] = await db
      .select({
        id: schema.wallets.id,
        label: schema.wallets.label,
        address: schema.wallets.address,
        chainId: schema.wallets.chainId,
        keyFormat: schema.wallets.keyFormat,
        active: schema.wallets.active,
        spendLimit: schema.wallets.spendLimit,
        createdAt: schema.wallets.createdAt,
      })
      .from(schema.wallets)
      .where(eq(schema.wallets.id, id))
      .limit(1);

    return NextResponse.json(wallet);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
