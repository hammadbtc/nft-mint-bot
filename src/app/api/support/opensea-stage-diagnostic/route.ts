import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getSigner } from "@/lib/vault";
import { getProvider } from "@/lib/chains";
import { diagnoseOpenSeaStageMapping } from "@/lib/adapters/opensea-signed-seadrop-v1";

const TOKEN_HASH = "e87c2d8f5b86a385024f04855b908ef86d9b396da5337a23bb600cb5e560bfa6";
const COLLECTION_ID = "a82f9217-2303-4a2c-a536-8acf067afda4";

function authorized(req: NextRequest): boolean {
  const digest = createHash("sha256").update(req.headers.get("x-diagnostic-token") || "").digest();
  const expected = Buffer.from(TOKEN_HASH, "hex");
  return digest.length === expected.length && timingSafeEqual(digest, expected);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [[collection], wallets] = await Promise.all([
    db.select().from(schema.collections).where(eq(schema.collections.id, COLLECTION_ID)).limit(1),
    db.select({ id: schema.wallets.id }).from(schema.wallets).where(and(eq(schema.wallets.chainId, 4663), eq(schema.wallets.active, true))),
  ]);
  if (!collection) return NextResponse.json({ error: "Collection missing" }, { status: 404 });
  const results = [];
  for (const [index, wallet] of wallets.entries()) {
    try {
      const signer = await getSigner(wallet.id, getProvider(collection.chainId));
      results.push({ wallet: index + 1, ...(await diagnoseOpenSeaStageMapping(collection, signer)) });
    } catch (error) {
      results.push({ wallet: index + 1, error: error instanceof Error ? error.message.replace(/0x[a-fA-F0-9]{40}/g, "[address]") : "Diagnostic failed" });
    }
  }
  return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
