import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { batchMint } from "@/lib/engine/mint";
import { getProvider } from "@/lib/chains";
import { liveTransactionsEnabled, safeErrorMessage } from "@/lib/safety";

const COOKIEZ_COLLECTION_ID = "c00c1e20-7ba1-4663-9000-000000000005";
const COOKIEZ_CONTRACT = "0x4BA87E60e52C19c1da7Dab74414dEaC4e237c23a";
const inputSchema = z.object({ walletId: z.string().uuid(), target: z.coerce.number().int().min(1).max(5).default(5) });

export async function POST(req: NextRequest) {
  try {
    if (!liveTransactionsEnabled()) throw new Error("Live broadcast is locked");
    const input = inputSchema.parse(await req.json());
    const [[wallet], [collection]] = await Promise.all([
      db.select().from(schema.wallets).where(eq(schema.wallets.id, input.walletId)).limit(1),
      db.select().from(schema.collections).where(eq(schema.collections.id, COOKIEZ_COLLECTION_ID)).limit(1),
    ]);
    if (!wallet?.active || wallet.chainId !== 4663) throw new Error("Choose an active Robinhood wallet");
    if (!collection?.active || !collection.verified || collection.adapterKey !== "cookiez-free-v1") throw new Error("COOKIEZ automation is unavailable");

    const provider = getProvider(4663);
    const bakers = new ethers.Contract(COOKIEZ_CONTRACT, ["function balanceOf(address) view returns (uint256)"], provider);
    const current = Number(await bakers.balanceOf(wallet.address));
    if (current >= input.target) return NextResponse.json({ success: true, alreadyComplete: true, current, target: input.target }, { headers: { "Cache-Control": "no-store" } });
    const needed = input.target - current;
    const key = req.headers.get("idempotency-key") || `cookiez-quick:${input.walletId}:${input.target}:${randomUUID()}`;
    const batch = await batchMint(
      COOKIEZ_COLLECTION_ID,
      [input.walletId],
      needed,
      false,
      false,
      key,
      [{ walletId: input.walletId, phaseId: "free" }],
    );
    return NextResponse.json({ success: true, current, target: input.target, needed, ...batch }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not start COOKIEZ automation");
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
