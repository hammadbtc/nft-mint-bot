import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { previewDisperse, queueDisperse, retryNeverBroadcastDisperse, type DispersePreview } from "@/lib/disperse";
import { safeErrorMessage } from "@/lib/safety";
import { db, schema } from "@/lib/db";
import { desc, inArray } from "drizzle-orm";

const transferPlan = z.object({
  fromWalletId: z.string().uuid(),
  toWalletId: z.string().uuid(),
  amountWei: z.string().regex(/^\d+$/),
  gasLimit: z.string().regex(/^\d+$/),
  maxFeePerGas: z.string().regex(/^\d+$/),
  maxPriorityFeePerGas: z.string().regex(/^\d+$/).nullable(),
});
const previewSchema = z.object({
  version: z.literal(2),
  type: z.enum(["fund", "sweep"]),
  mainWalletId: z.string().uuid(),
  workerWalletIds: z.array(z.string().uuid()),
  chainId: z.number().int().positive(),
  transfers: z.array(transferPlan).min(1).max(500),
  estimatedGasWei: z.string().regex(/^\d+$/),
  totalRequiredWei: z.string().regex(/^\d+$/),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  fingerprint: z.string().length(64),
});
const input = z.object({
  action: z.enum(["preview", "execute"]),
  type: z.enum(["fund", "sweep"]),
  mainWalletId: z.string().uuid(),
  workerWalletIds: z.array(z.string().uuid()).min(1).max(500),
  chainId: z.number().int().positive(),
  amountPerWallet: z.string().optional(),
  expected: previewSchema.optional(),
});
const retryInput = z.object({ action: z.literal("retry"), operationId: z.string().uuid() });

export async function GET(req: NextRequest) {
  const requested = Number(req.nextUrl.searchParams.get("limit") || 50);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 200)) : 50;
  const operations = await db.select().from(schema.disperseOperations).orderBy(desc(schema.disperseOperations.createdAt)).limit(limit);
  const transfers = operations.length
    ? await db.select().from(schema.disperseTransfers).where(inArray(schema.disperseTransfers.operationId, operations.map((item) => item.id)))
    : [];
  return NextResponse.json(operations.map((operation) => ({
    ...operation,
    previewJson: null,
    transfers: transfers.filter((transfer) => transfer.operationId === operation.id).map((transfer) => ({ ...transfer, rawTx: null })),
  })), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  try {
    const raw: unknown = await req.json();
    const retry = retryInput.safeParse(raw);
    if (retry.success) return NextResponse.json(await retryNeverBroadcastDisperse(retry.data.operationId), { status: 202, headers: { "Cache-Control": "no-store" } });
    const body = input.parse(raw);
    const operation = { type: body.type, mainWalletId: body.mainWalletId, workerWalletIds: body.workerWalletIds, chainId: body.chainId, amountPerWallet: body.amountPerWallet };
    if (body.action === "preview") return NextResponse.json(await previewDisperse(operation), { headers: { "Cache-Control": "no-store" } });
    if (!body.expected) throw new Error("An exact reviewed preview is required");
    const key = req.headers.get("idempotency-key");
    if (!key) return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });
    return NextResponse.json(await queueDisperse(operation, body.expected as DispersePreview, key), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Disperse failed");
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
