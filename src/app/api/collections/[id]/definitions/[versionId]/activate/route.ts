import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { deploymentVersion } from "@/lib/deployment";
import { definitionCollectionFields, MINT_CERTIFIER_VERSION } from "@/lib/mint-certification";
import { cutoverReadiness } from "@/lib/mint-cutover";
import { certificationIntegrityError, hashMintDefinition, MINT_DEFINITION_ENGINE_VERSION, parseMintDefinition } from "@/lib/mint-definitions";
import { safeErrorMessage, safeSecretEqual, stableHash } from "@/lib/safety";

type Context = { params: Promise<{ id: string; versionId: string }> };
const noStore = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const adminToken = process.env.SUPPORT_ADMIN_TOKEN;
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!adminToken || !safeSecretEqual(supplied, adminToken)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id, versionId } = await params;
    const now = new Date().toISOString();
    const actorHash = stableHash(supplied).slice(0, 24);
    const result = await db.transaction(async (tx) => {
      // Every lifecycle writer takes these locks in this order. This makes the
      // final parity count, definition swap, and cutover state one atomic gate.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-cutover:${id}`}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-definition:${id}`}))`);
      const [[collection], [version]] = await Promise.all([
        tx.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1),
        tx.select().from(schema.mintDefinitionVersions).where(and(
          eq(schema.mintDefinitionVersions.id, versionId),
          eq(schema.mintDefinitionVersions.collectionId, id),
        )).limit(1),
      ]);
      if (!collection || !version) return null;
      if (version.status !== "certified") throw new Error(`Definition status ${version.status} cannot be activated`);
      if (version.engineVersion !== MINT_DEFINITION_ENGINE_VERSION) throw new Error("Definition engine version is unsupported");
      const definition = parseMintDefinition(version.definitionJson);
      if (hashMintDefinition(definition) !== version.definitionHash) throw new Error("Stored definition failed its integrity check");
      const certificates = await tx.select().from(schema.mintCertifications).where(and(
        eq(schema.mintCertifications.definitionVersionId, version.id),
        eq(schema.mintCertifications.definitionHash, version.definitionHash),
        eq(schema.mintCertifications.status, "passed"),
        eq(schema.mintCertifications.runnerVersion, MINT_CERTIFIER_VERSION),
        gt(schema.mintCertifications.expiresAt, now),
      )).orderBy(desc(schema.mintCertifications.certifiedAt)).limit(10);
      const certificate = certificates.find((item) => !certificationIntegrityError(item, version.definitionHash));
      if (!certificate) throw new Error("A passed hash-bound certification is required");
      if (!certificate.expiresAt || Date.parse(certificate.expiresAt) <= Date.now()) throw new Error("Mint certification has expired");
      const deployedCommit = deploymentVersion();
      if (deployedCommit !== "local" && !certificate.sourceCommit?.startsWith(deployedCommit)) {
        throw new Error("Mint certification belongs to a different deployment commit");
      }
      const [current] = await tx.select().from(schema.mintDefinitionVersions).where(and(
        eq(schema.mintDefinitionVersions.collectionId, id),
        eq(schema.mintDefinitionVersions.status, "active"),
      )).limit(1);
      let cutoverState: typeof schema.mintCutoverStates.$inferSelect | undefined;
      if (current && current.id !== version.id) {
        [cutoverState] = await tx.select().from(schema.mintCutoverStates).where(and(
          eq(schema.mintCutoverStates.collectionId, id),
          eq(schema.mintCutoverStates.candidateDefinitionVersionId, version.id),
          eq(schema.mintCutoverStates.status, "ready"),
        )).limit(1);
        if (!cutoverState) throw new Error("A ready exact-parity cutover audit is required before replacing an active definition");
        const [counts] = await tx.select({
          matchedCount: sql<number>`count(*) filter (where ${schema.mintShadowComparisons.status} = 'match')::int`,
          mismatchedCount: sql<number>`count(*) filter (where ${schema.mintShadowComparisons.status} = 'mismatch')::int`,
          errorCount: sql<number>`count(*) filter (where ${schema.mintShadowComparisons.status} = 'error')::int`,
        }).from(schema.mintShadowComparisons).where(and(
          eq(schema.mintShadowComparisons.collectionId, id),
          eq(schema.mintShadowComparisons.candidateDefinitionVersionId, version.id),
          eq(schema.mintShadowComparisons.auditCycle, cutoverState.auditCycle),
        ));
        const metrics = {
          requiredSamples: cutoverState.requiredSamples,
          matchedCount: counts?.matchedCount || 0,
          mismatchedCount: counts?.mismatchedCount || 0,
          errorCount: counts?.errorCount || 0,
        };
        const readiness = cutoverReadiness(metrics);
        if (!readiness.ready) throw new Error(readiness.blockers.join("; "));
        cutoverState = { ...cutoverState, ...metrics };
      }
      if (current) {
        await tx.update(schema.mintDefinitionVersions).set({ status: "retired", updatedAt: now })
          .where(and(eq(schema.mintDefinitionVersions.id, current.id), ne(schema.mintDefinitionVersions.id, version.id)));
      }
      const pauseReason = "Newly activated definition requires explicit operator release";
      await tx.update(schema.collections).set({
        ...definitionCollectionFields(definition),
        active: true,
        verified: true,
        broadcastPaused: true,
        broadcastPauseReason: pauseReason,
        broadcastPauseUpdatedAt: now,
      }).where(eq(schema.collections.id, id));
      await tx.update(schema.mintDefinitionVersions).set({ status: "active", activatedAt: now, updatedAt: now })
        .where(and(eq(schema.mintDefinitionVersions.id, version.id), eq(schema.mintDefinitionVersions.status, "certified")));
      if (cutoverState) {
        await tx.update(schema.mintCutoverStates).set({
          matchedCount: cutoverState.matchedCount,
          mismatchedCount: cutoverState.mismatchedCount,
          errorCount: cutoverState.errorCount,
          status: "cutover",
          reason: "Candidate atomically activated after exact shadow parity",
          updatedAt: now,
        }).where(and(
          eq(schema.mintCutoverStates.collectionId, id),
          eq(schema.mintCutoverStates.candidateDefinitionVersionId, version.id),
          eq(schema.mintCutoverStates.status, "ready"),
        ));
      }
      const activationId = crypto.randomUUID();
      await tx.insert(schema.mintDefinitionActivations).values({
        id: activationId,
        collectionId: id,
        fromDefinitionVersionId: current?.id || null,
        toDefinitionVersionId: version.id,
        certificationId: certificate.id,
        definitionHash: version.definitionHash,
        actorHash,
        activatedAt: now,
      });
      await tx.insert(schema.mintControlEvents).values({
        id: crypto.randomUUID(), collectionId: id, phaseId: null,
        paused: true, reason: pauseReason, actorHash,
      });
      return { activationId, certificateId: certificate.id, version, now, pauseReason, cutoverCompleted: Boolean(cutoverState) };
    });
    if (!result) return NextResponse.json({ error: "Mint definition was not found" }, { status: 404, headers: noStore });
    return NextResponse.json({
      activationId: result.activationId,
      certificationId: result.certificateId,
      definitionVersionId: result.version.id,
      definitionHash: result.version.definitionHash,
      status: "active",
      broadcastPaused: true,
      pauseReason: result.pauseReason,
      cutoverCompleted: result.cutoverCompleted,
      activatedAt: result.now,
    }, { status: 201, headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not activate mint definition") }, { status: 400, headers: noStore });
  }
}
