import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { supportedAdapterKeys } from "@/lib/adapters";
import { hashMintDefinition, serializeMintDefinition, snapshotCollectionDefinition } from "@/lib/mint-definitions";
import { safeErrorMessage, safeSecretEqual } from "@/lib/safety";
import { validateReviewedCallConfig } from "@/lib/reviewed-call-config";

const noStore = { "Cache-Control": "no-store" };

// Registration is deliberately draft-only. Certification and activation are
// separate lifecycle operations, so request data can never self-authorize.
export const draftMintSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(100),
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.coerce.number().int().positive(),
  mintMethod: z.string().trim().min(1),
  mintAbi: z.union([z.string(), z.array(z.unknown())]),
  mintPrice: z.string().regex(/^\d+$/).optional(),
  maxPerWallet: z.number().int().positive().optional(),
  maxSupply: z.number().int().positive().optional(),
  paymentToken: z.string().optional(),
  adapterKey: z.string().default("reviewed-call-v1"),
  domains: z.array(z.string().trim().min(1)).min(1),
  siteUrl: z.string().url(),
  imageUrl: z.string().url().optional(),
  adapterConfig: z.record(z.string(), z.unknown()).default({}),
}).strict();

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const rows = await db.select().from(schema.collections)
    .where(chainId ? eq(schema.collections.chainId, Number(chainId)) : undefined)
    .orderBy(schema.collections.createdAt);
  return NextResponse.json(rows, { headers: noStore });
}

export async function POST(req: NextRequest) {
  try {
    const adminToken = process.env.SUPPORT_ADMIN_TOKEN;
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!adminToken || !safeSecretEqual(supplied, adminToken)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const input = draftMintSchema.parse(await req.json());
    if (!supportedAdapterKeys().includes(input.adapterKey)) throw new Error("Unknown adapter key");
    const mintAbi = typeof input.mintAbi === "string" ? input.mintAbi : JSON.stringify(input.mintAbi);
    JSON.parse(mintAbi);
    const id = input.id || crypto.randomUUID();

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-definition:${id}`}))`);
      let [collection] = await tx.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1);
      const submitted = {
        name: input.name,
        slug: input.slug,
        contractAddress: input.contractAddress,
        chainId: input.chainId,
        mintMethod: input.mintMethod,
        mintAbi,
        mintPrice: input.mintPrice || null,
        maxPerWallet: input.maxPerWallet || null,
        maxSupply: input.maxSupply || null,
        paymentToken: input.paymentToken || null,
        adapterKey: input.adapterKey,
        domains: JSON.stringify(input.domains),
        siteUrl: input.siteUrl,
        imageUrl: input.imageUrl || null,
        adapterConfig: JSON.stringify(input.adapterConfig),
      };
      if (!collection) {
        [collection] = await tx.insert(schema.collections).values({
          id,
          ...submitted,
          active: false,
          verified: false,
        }).returning();
      }

      // Existing live rows remain untouched. Their mutable controls and
      // execution fields continue to serve the currently active definition.
      const proposedCollection = { ...collection, ...submitted };
      if (input.adapterKey === "reviewed-call-v1") validateReviewedCallConfig(proposedCollection);
      const definition = snapshotCollectionDefinition(proposedCollection);
      const definitionHash = hashMintDefinition(definition);
      const [duplicate] = await tx.select().from(schema.mintDefinitionVersions).where(sql`
        ${schema.mintDefinitionVersions.collectionId} = ${id}
        and ${schema.mintDefinitionVersions.definitionHash} = ${definitionHash}
      `).limit(1);
      if (duplicate) {
        if (duplicate.status !== "draft") throw new Error(`An identical definition already exists with status ${duplicate.status}`);
        return { collection, definition: duplicate, duplicate: true };
      }

      const rows = await tx.select({ nextVersion: sql<number>`coalesce(max(${schema.mintDefinitionVersions.version}), 0) + 1` })
        .from(schema.mintDefinitionVersions)
        .where(eq(schema.mintDefinitionVersions.collectionId, id));
      const [created] = await tx.insert(schema.mintDefinitionVersions).values({
        id: crypto.randomUUID(),
        collectionId: id,
        version: Number(rows[0]?.nextVersion || 1),
        status: "draft",
        definitionJson: serializeMintDefinition(definition),
        definitionHash,
        source: "admin",
      }).returning();
      return { collection, definition: created, duplicate: false };
    });

    return NextResponse.json({
      collectionId: id,
      definitionVersionId: result.definition.id,
      version: result.definition.version,
      definitionHash: result.definition.definitionHash,
      status: result.definition.status,
      duplicate: result.duplicate,
      active: result.collection.active,
      verified: result.collection.verified,
    }, { status: result.duplicate ? 200 : 201, headers: noStore });
  } catch (error: unknown) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not register mint");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
