import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { cutoverReadiness } from "@/lib/mint-cutover";
import { hashMintDefinition, parseMintDefinition } from "@/lib/mint-definitions";
import { safeErrorMessage, safeSecretEqual, stableHash } from "@/lib/safety";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start-shadow"), candidateDefinitionVersionId: z.string().uuid(), requiredSamples: z.number().int().min(3).max(10_000).default(20) }).strict(),
  z.object({ action: z.literal("evaluate") }).strict(),
  z.object({ action: z.literal("mark-cutover") }).strict(),
  z.object({ action: z.literal("mark-rollback"), reason: z.string().trim().min(1).max(500) }).strict(),
]);

function authorized(req: NextRequest): boolean {
  const expected = process.env.SUPPORT_ADMIN_TOKEN || "";
  return Boolean(expected) && safeSecretEqual(req.headers.get("x-support-admin-token") || "", expected);
}

export async function GET(req: NextRequest, { params }: Context) {
  if (!authorized(req)) return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
  const { id } = await params;
  const [state] = await db.select().from(schema.mintCutoverStates).where(eq(schema.mintCutoverStates.collectionId, id)).limit(1);
  if (!state) return NextResponse.json({ error: "No cutover audit exists" }, { status: 404, headers: noStore });
  const comparisons = await db.select().from(schema.mintShadowComparisons)
    .where(eq(schema.mintShadowComparisons.collectionId, id)).orderBy(desc(schema.mintShadowComparisons.createdAt)).limit(100);
  return NextResponse.json({ state, readiness: cutoverReadiness(state), comparisons }, { headers: noStore });
}

export async function POST(req: NextRequest, { params }: Context) {
  try {
    if (!authorized(req)) return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    const { id } = await params;
    const input = bodySchema.parse(await req.json());
    const now = new Date().toISOString();
    const actorHash = stableHash(req.headers.get("x-support-admin-token") || "").slice(0, 24);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-cutover:${id}`}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-definition:${id}`}))`);
      const [[collection], [state]] = await Promise.all([
        tx.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1),
        tx.select().from(schema.mintCutoverStates).where(eq(schema.mintCutoverStates.collectionId, id)).limit(1),
      ]);
      if (!collection) throw new Error("Mint collection was not found");
      if (input.action === "start-shadow") {
        if (state && state.status !== "rollback") throw new Error("A cutover audit already exists; explicitly roll it back before creating a new cycle");
        const [candidate] = await tx.select().from(schema.mintDefinitionVersions).where(and(
          eq(schema.mintDefinitionVersions.id, input.candidateDefinitionVersionId),
          eq(schema.mintDefinitionVersions.collectionId, id),
          eq(schema.mintDefinitionVersions.status, "certified"),
        )).limit(1);
        if (!candidate) throw new Error("Candidate must be a certified definition for this collection");
        if (hashMintDefinition(parseMintDefinition(candidate.definitionJson)) !== candidate.definitionHash) throw new Error("Candidate definition failed integrity validation");
        if (state) {
          const [restarted] = await tx.update(schema.mintCutoverStates).set({
            legacyAdapterKey: collection.adapterKey, candidateDefinitionVersionId: candidate.id,
            auditCycle: state.auditCycle + 1,
            requiredSamples: input.requiredSamples, matchedCount: 0, mismatchedCount: 0, errorCount: 0,
            lastComparisonAt: null, status: "shadow", reason: "Collecting exact transaction-intent parity samples", updatedAt: now,
          }).where(eq(schema.mintCutoverStates.collectionId, id)).returning();
          return restarted;
        }
        const [created] = await tx.insert(schema.mintCutoverStates).values({ collectionId: id, legacyAdapterKey: collection.adapterKey,
          candidateDefinitionVersionId: candidate.id, requiredSamples: input.requiredSamples, status: "shadow",
          reason: "Collecting exact transaction-intent parity samples", createdAt: now, updatedAt: now }).returning();
        return created;
      }
      if (!state) throw new Error("No cutover audit exists");
      const [counts] = await tx.select({
        matchedCount: sql<number>`count(*) filter (where ${schema.mintShadowComparisons.status} = 'match')::int`,
        mismatchedCount: sql<number>`count(*) filter (where ${schema.mintShadowComparisons.status} = 'mismatch')::int`,
        errorCount: sql<number>`count(*) filter (where ${schema.mintShadowComparisons.status} = 'error')::int`,
      }).from(schema.mintShadowComparisons).where(and(
        eq(schema.mintShadowComparisons.collectionId, id),
        eq(schema.mintShadowComparisons.candidateDefinitionVersionId, state.candidateDefinitionVersionId),
        eq(schema.mintShadowComparisons.auditCycle, state.auditCycle),
      ));
      const metrics = { requiredSamples: state.requiredSamples, matchedCount: counts?.matchedCount || 0, mismatchedCount: counts?.mismatchedCount || 0, errorCount: counts?.errorCount || 0 };
      if (input.action === "evaluate") {
        const readiness = cutoverReadiness(metrics);
        const [updated] = await tx.update(schema.mintCutoverStates).set({
          ...metrics, status: readiness.ready ? "ready" : "shadow",
          reason: readiness.ready ? "Exact intent parity threshold satisfied" : readiness.blockers.join("; "), updatedAt: now,
        }).where(eq(schema.mintCutoverStates.collectionId, id)).returning();
        return updated;
      }
      if (input.action === "mark-cutover") {
        if (state.status === "cutover") return state;
        throw new Error("Cutover is completed atomically by the definition activation gate; activate the ready candidate instead");
      }
      const [updated] = await tx.update(schema.mintCutoverStates).set({ ...metrics, status: "rollback", reason: input.reason, updatedAt: now })
        .where(eq(schema.mintCutoverStates.collectionId, id)).returning();
      await tx.update(schema.collections).set({
        broadcastPaused: true,
        broadcastPauseReason: `Cutover rollback: ${input.reason}`,
        broadcastPauseUpdatedAt: now,
      }).where(eq(schema.collections.id, id));
      await tx.insert(schema.mintControlEvents).values({
        id: crypto.randomUUID(), collectionId: id, phaseId: null,
        paused: true, reason: `Cutover rollback: ${input.reason}`, actorHash,
      });
      return updated;
    });
    return NextResponse.json({ state: result, readiness: cutoverReadiness(result) }, { headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not update cutover audit");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
