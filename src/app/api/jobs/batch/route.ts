import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { batchMint } from "@/lib/engine/mint";

const schema = z.object({
  collectionId:z.string().uuid(), walletIds:z.array(z.string().uuid()).min(1).max(500),
  quantity:z.coerce.number().int().min(1).max(100).default(1), scheduledAt:z.string().datetime().optional(),
  dryRun:z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await req.json());
    if (!input.dryRun && process.env.ENABLE_LIVE_TRANSACTIONS !== "true") {
      return NextResponse.json({ error:"Live mint transactions are disabled until testnet verification is complete" }, { status:403 });
    }
    const idempotencyKey = req.headers.get("idempotency-key") || crypto.randomUUID();
    const results = await batchMint(input.collectionId, [...new Set(input.walletIds)], input.quantity, false, input.dryRun, input.scheduledAt, idempotencyKey);
    return NextResponse.json({ success:true, results, idempotencyKey }, { status:202, headers:{"Cache-Control":"no-store"} });
  } catch (error: unknown) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Could not create mint tasks";
    return NextResponse.json({ error:message }, { status:400 });
  }
}
