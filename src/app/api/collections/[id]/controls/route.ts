import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { safeErrorMessage, safeSecretEqual, stableHash } from "@/lib/safety";
import { certificationIntegrityError } from "@/lib/mint-definitions";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };
const controlSchema = z.object({
  projectPaused: z.boolean().optional(),
  phaseId: z.string().trim().min(1).max(100).optional(),
  phasePaused: z.boolean().optional(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, ctx) => {
  if (value.projectPaused === undefined && value.phasePaused === undefined) {
    ctx.addIssue({ code: "custom", message: "A project or phase control is required" });
  }
  if ((value.phaseId === undefined) !== (value.phasePaused === undefined)) {
    ctx.addIssue({ code: "custom", message: "phaseId and phasePaused must be supplied together" });
  }
});

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const adminToken = process.env.SUPPORT_ADMIN_TOKEN;
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!adminToken || !safeSecretEqual(supplied, adminToken)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id } = await params;
    const input = controlSchema.parse(await req.json());
    const now = new Date().toISOString();
    const actorHash = stableHash(supplied).slice(0, 24);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-cutover:${id}`}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-definition:${id}`}))`);
      const [collection] = await tx.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1);
      if (!collection) return null;
      if (input.projectPaused !== undefined) {
        if (input.projectPaused === false) {
          const [active] = await tx.select().from(schema.mintDefinitionVersions).where(and(
            eq(schema.mintDefinitionVersions.collectionId, id),
            eq(schema.mintDefinitionVersions.status, "active"),
          )).limit(1);
          if (!active) throw new Error("A certified active definition is required before broadcasting can be released");
          const certificates = await tx.select().from(schema.mintCertifications).where(and(
            eq(schema.mintCertifications.definitionVersionId, active.id),
            eq(schema.mintCertifications.definitionHash, active.definitionHash),
            eq(schema.mintCertifications.status, "passed"),
            eq(schema.mintCertifications.runnerVersion, "mint-certifier-v1"),
            gt(schema.mintCertifications.expiresAt, now),
          )).orderBy(desc(schema.mintCertifications.certifiedAt)).limit(10);
          const certificate = certificates.find((item) => !certificationIntegrityError(item, active.definitionHash));
          if (!certificate) throw new Error("The active definition has no valid certification");
          const [activation] = await tx.select().from(schema.mintDefinitionActivations).where(eq(
            schema.mintDefinitionActivations.toDefinitionVersionId, active.id,
          )).orderBy(desc(schema.mintDefinitionActivations.activatedAt)).limit(1);
          if (activation?.fromDefinitionVersionId) {
            const [cutover] = await tx.select().from(schema.mintCutoverStates).where(and(
              eq(schema.mintCutoverStates.collectionId, id),
              eq(schema.mintCutoverStates.candidateDefinitionVersionId, active.id),
              eq(schema.mintCutoverStates.status, "cutover"),
            )).limit(1);
            if (!cutover) throw new Error("Exact-parity cutover must complete before broadcasting can be released");
          }
        }
        await tx.update(schema.collections).set({
          broadcastPaused: input.projectPaused,
          broadcastPauseReason: input.reason || null,
          broadcastPauseUpdatedAt: now,
        }).where(eq(schema.collections.id, id));
        await tx.insert(schema.mintControlEvents).values({
          id: crypto.randomUUID(), collectionId: id, phaseId: null,
          paused: input.projectPaused, reason: input.reason || null, actorHash,
        });
      }
      if (input.phaseId && input.phasePaused !== undefined) {
        await tx.insert(schema.mintPhaseControls).values({
          collectionId: id,
          phaseId: input.phaseId,
          paused: input.phasePaused,
          reason: input.reason || null,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [schema.mintPhaseControls.collectionId, schema.mintPhaseControls.phaseId],
          set: { paused: input.phasePaused, reason: input.reason || null, updatedAt: now },
        });
        await tx.insert(schema.mintControlEvents).values({
          id: crypto.randomUUID(), collectionId: id, phaseId: input.phaseId,
          paused: input.phasePaused, reason: input.reason || null, actorHash,
        });
      }
      return {
        collectionId: id,
        projectPaused: input.projectPaused ?? collection.broadcastPaused,
        phaseId: input.phaseId,
        phasePaused: input.phasePaused,
        reason: input.reason,
        updatedAt: now,
      };
    });
    if (!result) return NextResponse.json({ error: "Mint was not found" }, { status: 404, headers: noStore });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not update mint controls");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
