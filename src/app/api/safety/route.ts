import { NextRequest, NextResponse } from "next/server";
import { addToSafetyList, removeFromSafetyList, listSafetyList } from "@/lib/engine/safety";

export async function GET(req: NextRequest) {
  const list = req.nextUrl.searchParams.get("list") as "whitelist" | "blacklist" | null;
  const rows = await listSafetyList(list || undefined);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { address, list, note } = body;
    if (!address || !list || !["whitelist", "blacklist"].includes(list)) {
      return NextResponse.json({ error: "address and list (whitelist|blacklist) required" }, { status: 400 });
    }
    await addToSafetyList(address, list, note);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
  await removeFromSafetyList(address);
  return NextResponse.json({ success: true });
}
