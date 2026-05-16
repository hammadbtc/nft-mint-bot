import { NextRequest, NextResponse } from "next/server";
import { scanContract } from "@/lib/contract-scanner";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  const chainId = parseInt(req.nextUrl.searchParams.get("chainId") || "1");

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid contract address" }, { status: 400 });
  }

  try {
    const result = await scanContract(address, chainId);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to scan contract" }, { status: 500 });
  }
}
