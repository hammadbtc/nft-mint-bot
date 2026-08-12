import { NextResponse } from "next/server";
import { listChains } from "@/lib/chains";

export async function GET() {
  const chains = listChains();
  return NextResponse.json(chains.map((chain) => ({ id: chain.id, name: chain.name, symbol: chain.symbol, explorerUrl: chain.explorerUrl })), { headers: { "Cache-Control": "no-store" } });
}
