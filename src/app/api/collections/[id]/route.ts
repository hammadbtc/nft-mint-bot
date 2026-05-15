import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.delete(schema.collections).where(eq(schema.collections.id, id));
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, id))
    .limit(1);

  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  return NextResponse.json(collection);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    // Only update provided fields
    const updates: Record<string, any> = {};
    const allowedFields = [
      "name", "contractAddress", "chainId", "mintMethod", "mintAbi", "mintPrice",
      "maxPerWallet", "maxSupply", "paymentToken",
      "defaultGasLimit", "defaultMaxFeePerGas", "defaultMaxPriorityFeePerGas",
      "defaultUseFlashbots", "fcfsMintOpenSignature", "fcfsEnabled",
      "safetyCheck", "active",
    ];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    // Validate ABI if provided
    if (updates.mintAbi) {
      try {
        JSON.parse(typeof updates.mintAbi === "string" ? updates.mintAbi : JSON.stringify(updates.mintAbi));
      } catch {
        return NextResponse.json({ error: "mintAbi must be valid JSON" }, { status: 400 });
      }
      updates.mintAbi = typeof updates.mintAbi === "string" ? updates.mintAbi : JSON.stringify(updates.mintAbi);
    }

    await db
      .update(schema.collections)
      .set(updates)
      .where(eq(schema.collections.id, id));

    const [updated] = await db.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1);
    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
