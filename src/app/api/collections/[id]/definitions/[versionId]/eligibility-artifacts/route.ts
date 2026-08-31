import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { collectionFromDefinition, hashMintDefinition, parseMintDefinition } from "@/lib/mint-definitions";
import { persistEligibilityArtifact, validateEligibilityArtifact } from "@/lib/eligibility-artifacts";
import { validateReviewedCallConfig } from "@/lib/reviewed-call-config";
import { safeErrorMessage, safeSecretEqual } from "@/lib/safety";

type Context = { params: Promise<{ id: string; versionId: string }> };
const noStore = { "Cache-Control": "no-store" };
const inputSchema = z.object({
  phaseId: z.string().trim().min(1).max(100),
  artifacts: z.array(z.object({
    walletId: z.string().uuid(),
    payload: z.record(z.string().min(1).max(100), z.unknown()),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime().nullable().optional(),
  }).strict()).min(1).max(1000),
}).strict();

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const expected = process.env.SUPPORT_ADMIN_TOKEN || "";
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!expected || !safeSecretEqual(supplied, expected)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id, versionId } = await params;
    const input = inputSchema.parse(await req.json());
    const [[collection], [version]] = await Promise.all([
      db.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1),
      db.select().from(schema.mintDefinitionVersions).where(and(
        eq(schema.mintDefinitionVersions.id, versionId),
        eq(schema.mintDefinitionVersions.collectionId, id),
      )).limit(1),
    ]);
    if (!collection || !version) return NextResponse.json({ error: "Mint definition was not found" }, { status: 404, headers: noStore });
    if (!['certified', 'active', 'paused'].includes(version.status)) throw new Error("Artifacts can only be loaded for a certified definition");
    const definition = parseMintDefinition(version.definitionJson);
    if (hashMintDefinition(definition) !== version.definitionHash) throw new Error("Stored definition failed its integrity check");
    const pinnedCollection = collectionFromDefinition(collection, definition);
    if (pinnedCollection.adapterKey !== "reviewed-call-v1") throw new Error("This definition does not use reviewed wallet artifacts");
    const config = validateReviewedCallConfig(pinnedCollection);
    const phase = config.phases.find((item) => item.id === input.phaseId);
    if (!phase) throw new Error("Reviewed phase was not found");
    const walletIds = [...new Set(input.artifacts.map((item) => item.walletId))];
    if (walletIds.length !== input.artifacts.length) throw new Error("Each wallet may appear only once per upload");
    const selectedWallets = await db.select().from(schema.wallets).where(inArray(schema.wallets.id, walletIds));
    if (selectedWallets.length !== walletIds.length) throw new Error("One or more artifact wallets were not found");
    const byId = new Map(selectedWallets.map((wallet) => [wallet.id, wallet]));
    for (const artifact of input.artifacts) {
      const wallet = byId.get(artifact.walletId)!;
      if (wallet.chainId !== definition.chainId) throw new Error(`${wallet.label} is configured for another chain`);
      if (artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now()) throw new Error(`${wallet.label} artifact is already expired`);
      validateEligibilityArtifact({ phase, walletAddress: wallet.address, payload: artifact.payload });
    }
    const stored = await Promise.all(input.artifacts.map(async (artifact) => {
      const wallet = byId.get(artifact.walletId)!;
      const result = await persistEligibilityArtifact({
        collectionId: id,
        definitionVersionId: versionId,
        definitionHash: version.definitionHash,
        phase,
        walletAddress: wallet.address,
        payload: artifact.payload,
        sourceHash: artifact.sourceHash,
        expiresAt: artifact.expiresAt,
      });
      return { walletId: wallet.id, ...result };
    }));
    return NextResponse.json({ collectionId: id, definitionVersionId: versionId, phaseId: phase.id, stored }, { status: 201, headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not store eligibility artifacts");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
