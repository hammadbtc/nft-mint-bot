import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { batchMint } from "@/lib/engine/mint";
import { safeErrorMessage } from "@/lib/safety";

const schema = z.object({
  collectionId:z.string().uuid(), walletIds:z.array(z.string().uuid()).min(1).max(500),
  phases:z.array(z.object({ walletId:z.string().uuid(), phaseId:z.string().min(1).max(100) })).min(1).max(1500).optional(),
  quantity:z.coerce.number().int().min(1).max(100).default(1),
  dryRun:z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await req.json());
    const idempotencyKey = req.headers.get("idempotency-key");
    if (!idempotencyKey) return NextResponse.json({ error:"Idempotency-Key header is required" }, { status:400 });
    const batch = await batchMint(input.collectionId, [...new Set(input.walletIds)], input.quantity, false, input.dryRun, idempotencyKey, input.phases);
    return NextResponse.json({ success:true, ...batch, idempotencyKey }, { status:202, headers:{"Cache-Control":"no-store"} });
  } catch (error: unknown) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not create mint tasks");
    return NextResponse.json({ error:message }, { status:400, headers:{"Cache-Control":"no-store"} });
  }
}
