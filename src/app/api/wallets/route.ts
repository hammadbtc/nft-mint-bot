import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { importWallet, listWallets, deriveMnemonicAddresses } from "@/lib/vault";
import { eq } from "drizzle-orm";

const importSchema = z.object({
  label: z.string().trim().min(1).max(80),
  chainId: z.coerce.number().int().positive(),
  keyType: z.enum(["private-key", "mnemonic"]),
  key: z.string().trim().min(1),
  hdPath: z.string().optional(),
  role: z.enum(["main", "worker"]).default("worker"),
  parentWalletId: z.string().uuid().optional(),
});

const generateSchema = z.object({
  action: z.literal("generate"),
  count: z.coerce.number().int().min(1).max(100).default(1),
  chainId: z.coerce.number().int().positive().default(1),
  prefix: z.string().trim().min(1).max(60).default("Wallet"),
  parentWalletId: z.string().uuid(),
});

async function assertMainWallet(id: string, chainId: number) {
  const [parent] = await db.select({ id: schema.wallets.id, role: schema.wallets.role, chainId: schema.wallets.chainId })
    .from(schema.wallets).where(eq(schema.wallets.id, id)).limit(1);
  if (!parent || parent.role !== "main") throw new Error("A valid main wallet is required");
  if (parent.chainId !== chainId) throw new Error("Main and worker wallets must use the same network");
}

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const wallets = await listWallets(chainId ? Number(chainId) : undefined);
  return NextResponse.json(wallets, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  try {
    const body: unknown = await req.json();
    if (typeof body === "object" && body !== null && "action" in body && body.action === "generate") {
      const input = generateSchema.parse(body);
      await assertMainWallet(input.parentWalletId, input.chainId);
      const generated: Array<{ id:string; label:string; address:string; chainId:number; privateKey:string }> = [];
      for (let index = 0; index < input.count; index++) {
        const fresh = ethers.Wallet.createRandom();
        const saved = await importWallet({
          label: `${input.prefix} ${String(index + 1).padStart(2, "0")}`,
          chainId: input.chainId,
          keyType: "private-key",
          key: fresh.privateKey,
          role: "worker",
          parentWalletId: input.parentWalletId,
        });
        generated.push({ ...saved, privateKey: fresh.privateKey });
      }
      return NextResponse.json(
        { wallets: generated, count: input.count, warning: "Private keys are returned once. Back them up now." },
        { status: 201, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" } },
      );
    }

    const input = importSchema.parse(body);
    if (input.keyType === "mnemonic") {
      const words = input.key.split(/\s+/);
      if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error("Seed phrase must contain 12, 15, 18, 21, or 24 words");
    }
    if (input.role === "worker") {
      if (!input.parentWalletId) throw new Error("Choose a main wallet for this worker");
      await assertMainWallet(input.parentWalletId, input.chainId);
    } else {
      const existingMain = (await listWallets(input.chainId)).find((wallet) => wallet.role === "main");
      if (existingMain) throw new Error("This network already has a main wallet");
    }
    const wallet = await importWallet(input);
    return NextResponse.json(wallet, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Wallet operation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = z.object({ mnemonic:z.string().min(1), count:z.number().int().min(1).max(100).default(10), basePath:z.string().optional() }).parse(await req.json());
    return NextResponse.json(deriveMnemonicAddresses(body.mnemonic, body.count, body.basePath), { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to derive addresses" }, { status: 400 });
  }
}
