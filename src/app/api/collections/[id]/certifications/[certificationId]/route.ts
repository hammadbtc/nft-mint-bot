import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { safeErrorMessage, safeSecretEqual, stableHash } from "@/lib/safety";
import { certificationIntegrityError } from "@/lib/mint-definitions";

type Context = { params: Promise<{ id: string; certificationId: string }> };
const noStore = { "Cache-Control": "no-store" };
const revokeSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const adminToken = process.env.SUPPORT_ADMIN_TOKEN;
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!adminToken || !safeSecretEqual(supplied, adminToken)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id, certificationId } = await params;
    const { reason } = revokeSchema.parse(await req.json());
    const now = new Date().toISOString();
    const actorHash = stableHash(supplied).slice(0, 24);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-definition:${id}`}))`);
      const [row] = await tx.select({
        certification: schema.mintCertifications,
        version: schema.mintDefinitionVersions,
      }).from(schema.mintCertifications)
        .innerJoin(schema.mintDefinitionVersions, eq(schema.mintCertifications.definitionVersionId, schema.mintDefinitionVersions.id))
        .where(and(
          eq(schema.mintCertifications.id, certificationId),
          eq(schema.mintDefinitionVersions.collectionId, id),
      )).limit(1);
      if (!row) return null;
      if (row.certification.status === "revoked") throw new Error("Certification is already revoked");
      if (row.certification.status !== "passed") throw new Error("Only a passed certification can be revoked");
      await tx.update(schema.mintCertifications).set({
        status: "revoked", revokedAt: now, revocationReason: reason,
      }).where(eq(schema.mintCertifications.id, certificationId));
      const remainingCandidates = await tx.select().from(schema.mintCertifications).where(and(
        eq(schema.mintCertifications.definitionVersionId, row.version.id),
        eq(schema.mintCertifications.definitionHash, row.version.definitionHash),
        eq(schema.mintCertifications.status, "passed"),
        eq(schema.mintCertifications.runnerVersion, "mint-certifier-v1"),
        gt(schema.mintCertifications.expiresAt, now),
      )).orderBy(desc(schema.mintCertifications.certifiedAt)).limit(10);
      const remaining = remainingCandidates.find((candidate) => !certificationIntegrityError(candidate, row.version.definitionHash));
      if (!remaining && ["active", "certified"].includes(row.version.status)) {
        await tx.update(schema.mintDefinitionVersions).set({ status: "paused", updatedAt: now })
          .where(eq(schema.mintDefinitionVersions.id, row.version.id));
      }
      if (!remaining && row.version.status === "active") {
        await tx.update(schema.collections).set({
          broadcastPaused: true,
          broadcastPauseReason: `Certification revoked: ${reason}`,
          broadcastPauseUpdatedAt: now,
        }).where(eq(schema.collections.id, id));
        await tx.insert(schema.mintControlEvents).values({
          id: crypto.randomUUID(), collectionId: id, phaseId: null,
          paused: true, reason: `Certification revoked: ${reason}`, actorHash,
        });
      }
      return { definitionVersionId: row.version.id, wasActive: !remaining && row.version.status === "active" };
    });
    if (!result) return NextResponse.json({ error: "Certification was not found" }, { status: 404, headers: noStore });
    return NextResponse.json({
      certificationId,
      definitionVersionId: result.definitionVersionId,
      status: "revoked",
      broadcastPaused: result.wasActive,
      revokedAt: now,
    }, { headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not revoke certification");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
