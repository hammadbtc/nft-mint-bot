import { NextRequest, NextResponse } from "next/server";
import { importWallet, listWallets, deleteWallet } from "@/lib/vault";

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const wallets = await listWallets(chainId ? parseInt(chainId) : undefined);
  return NextResponse.json(wallets);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { label, chainId, keyType, key } = body;

    if (!label || !chainId || !keyType || !key) {
      return NextResponse.json({ error: "label, chainId, keyType, and key are required" }, { status: 400 });
    }

    if (!["private-key", "mnemonic"].includes(keyType)) {
      return NextResponse.json({ error: "keyType must be 'private-key' or 'mnemonic'" }, { status: 400 });
    }

    const wallet = await importWallet({ label, chainId, keyType, key });
    return NextResponse.json(wallet, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to import wallet" }, { status: 500 });
  }
}
