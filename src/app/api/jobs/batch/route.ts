import { NextRequest, NextResponse } from "next/server";
import { batchMint } from "@/lib/engine/mint";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { collectionId, walletIds, quantity, useFlashbots, dryRun } = body;

    if (!collectionId || !walletIds || !walletIds.length) {
      return NextResponse.json(
        { error: "collectionId and walletIds (non-empty array) are required" },
        { status: 400 }
      );
    }

    const results = await batchMint(collectionId, walletIds, quantity || 1, useFlashbots, dryRun, body.scheduledAt);
    return NextResponse.json({ success: true, results, dryRun: dryRun ?? false });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Batch mint failed" }, { status: 500 });
  }
}
