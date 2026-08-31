import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { inspectMintResolver, mintResolverDescriptors } from "@/lib/resolvers";
import { safeErrorMessage, safeSecretEqual, stableHash, stableJson } from "@/lib/safety";

const noStore = { "Cache-Control": "no-store" };
const inputSchema = z.object({
  platform: z.string().trim().min(1).max(80),
  chainId: z.coerce.number().int().positive(),
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(100).optional(),
  siteUrl: z.url().optional(),
  domains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  feeRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  providerPayload: z.unknown().optional(),
}).strict();

function authorized(req: NextRequest): boolean {
  const expected = process.env.SUPPORT_ADMIN_TOKEN || "";
  return Boolean(expected) && safeSecretEqual(req.headers.get("x-support-admin-token") || "", expected);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
  return NextResponse.json({ resolvers: mintResolverDescriptors }, { headers: noStore });
}

export async function POST(req: NextRequest) {
  try {
    if (!authorized(req)) return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    const input = inputSchema.parse(await req.json());
    const requestHash = stableHash(input);
    const result = await inspectMintResolver(input);
    const resultJson = stableJson(result);
    const resultHash = stableHash({ requestHash, result });
    const id = crypto.randomUUID();
    await db.insert(schema.mintResolverRuns).values({
      id,
      resolverKey: result.resolverKey,
      resolverVersion: result.resolverVersion,
      chainId: result.chainId,
      contractAddress: result.contractAddress.toLowerCase(),
      status: result.status,
      requestHash,
      resultJson,
      resultHash,
      blockNumber: result.evidence.blockNumber,
      blockHash: result.evidence.blockHash,
      contractCodeHash: result.evidence.contractCodeHash,
    }).onConflictDoNothing({ target: schema.mintResolverRuns.resultHash });
    const [run] = await db.select({ id: schema.mintResolverRuns.id }).from(schema.mintResolverRuns)
      .where(eq(schema.mintResolverRuns.resultHash, resultHash)).limit(1);
    return NextResponse.json({ resolverRunId: run?.id || id, resultHash, ...result }, { status: result.status === "unsupported" ? 422 : 200, headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not inspect mint contract");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
