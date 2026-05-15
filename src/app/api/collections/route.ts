import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const conditions = [];
  if (chainId) {
    conditions.push(eq(schema.collections.chainId, parseInt(chainId)));
  }

  const rows = await db
    .select()
    .from(schema.collections)
    .where(conditions.length ? conditions[0] : undefined)
    .orderBy(schema.collections.createdAt);

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, contractAddress, chainId, mintMethod, mintAbi, mintPrice, maxPerWallet, maxSupply, paymentToken, defaultGasLimit, defaultMaxFeePerGas, defaultMaxPriorityFeePerGas, defaultUseFlashbots, fcfsMintOpenSignature } = body;

    if (!name || !contractAddress || !chainId || !mintMethod || !mintAbi) {
      return NextResponse.json(
        { error: "name, contractAddress, chainId, mintMethod, and mintAbi are required" },
        { status: 400 }
      );
    }

    // Validate ABI is valid JSON
    try {
      JSON.parse(typeof mintAbi === "string" ? mintAbi : JSON.stringify(mintAbi));
    } catch {
      return NextResponse.json({ error: "mintAbi must be valid JSON" }, { status: 400 });
    }

    const id = uuidv4();
    await db.insert(schema.collections).values({
      id,
      name,
      contractAddress,
      chainId: parseInt(chainId),
      mintMethod: mintMethod || "mint",
      mintAbi: typeof mintAbi === "string" ? mintAbi : JSON.stringify(mintAbi),
      mintPrice: mintPrice?.toString(),
      maxPerWallet: maxPerWallet || null,
      maxSupply: maxSupply || null,
      paymentToken: paymentToken || null,
      defaultGasLimit: defaultGasLimit || null,
      defaultMaxFeePerGas: defaultMaxFeePerGas || null,
      defaultMaxPriorityFeePerGas: defaultMaxPriorityFeePerGas || null,
      defaultUseFlashbots: defaultUseFlashbots ?? false,
      fcfsMintOpenSignature: fcfsMintOpenSignature || null,
    });

    const [created] = await db.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1);
    return NextResponse.json(created, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to add collection" }, { status: 500 });
  }
}
