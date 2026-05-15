import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { importWallet, listWallets, deriveMnemonicAddresses } from "@/lib/vault";

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const wallets = await listWallets(chainId ? parseInt(chainId) : undefined);
  return NextResponse.json(wallets);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { label, chainId, keyType, key, hdPath } = body;

    if (!label || !chainId || !keyType || !key) {
      return NextResponse.json({ error: "label, chainId, keyType, and key are required" }, { status: 400 });
    }

    if (!["private-key", "mnemonic"].includes(keyType)) {
      return NextResponse.json({ error: "keyType must be 'private-key' or 'mnemonic'" }, { status: 400 });
    }

    // Validate mnemonic
    if (keyType === "mnemonic") {
      const words = key.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 15 && words.length !== 18 && words.length !== 21 && words.length !== 24) {
        return NextResponse.json({ error: "Mnemonic must be 12, 15, 18, 21, or 24 words" }, { status: 400 });
      }
    }

    const wallet = await importWallet({
      label,
      chainId: parseInt(chainId),
      keyType,
      key,
      hdPath,
      spendLimit: body.spendLimit ? ethers.parseEther(body.spendLimit).toString() : undefined,
    });
    return NextResponse.json(wallet, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to import wallet" }, { status: 500 });
  }
}

// Derive addresses from mnemonic (preview before import)
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { mnemonic, count, basePath } = body;

    if (!mnemonic) {
      return NextResponse.json({ error: "mnemonic is required" }, { status: 400 });
    }

    const addresses = deriveMnemonicAddresses(mnemonic, count || 10, basePath);
    return NextResponse.json(addresses);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to derive addresses" }, { status: 500 });
  }
}
