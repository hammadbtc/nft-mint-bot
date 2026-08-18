import { NextRequest, NextResponse } from "next/server";
import { requireAppAccessPassword } from "@/lib/admin-auth";
import { safeErrorMessage } from "@/lib/safety";
import { getWalletSecret } from "@/lib/vault";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store, private", Pragma: "no-cache" };

export async function POST(req: NextRequest, { params }: Context) {
  try {
    requireAppAccessPassword(req);
    const { id } = await params;
    const wallet = await getWalletSecret(id);
    if (!wallet) return NextResponse.json({ error: "Wallet not found" }, { status: 404, headers: noStore });
    return NextResponse.json(wallet, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Could not reveal wallet key") },
      { status: 401, headers: noStore },
    );
  }
}
