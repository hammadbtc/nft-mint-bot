import { NextResponse } from "next/server";
import { listChains } from "@/lib/chains";

export async function GET() {
  const chains = listChains();
  return NextResponse.json(chains);
}
