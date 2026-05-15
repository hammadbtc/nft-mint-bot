import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { batchMint } from "@/lib/engine/mint";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { collectionId, walletIds, quantity } = body;

    if (!collectionId || !walletIds || !walletIds.length) {
      return NextResponse.json(
        { error: "collectionId and walletIds (non-empty array) are required" },
        { status: 400 }
      );
    }

    const results = await batchMint(collectionId, walletIds, quantity || 1);
    return NextResponse.json({ success: true, results });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Batch mint failed" }, { status: 500 });
  }
}
