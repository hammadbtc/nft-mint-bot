import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { deploymentVersion } from "@/lib/deployment";
import { certificationEvidenceSchema, evaluateMintCertification } from "@/lib/mint-certification";
import { hashMintDefinition, parseMintDefinition } from "@/lib/mint-definitions";
import { safeErrorMessage, safeSecretEqual, stableJson } from "@/lib/safety";

type Context = { params: Promise<{ id: string; versionId: string }> };
const noStore = { "Cache-Control": "no-store" };
const bodySchema = z.object({ evidence: certificationEvidenceSchema }).strict();

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const adminToken = process.env.SUPPORT_ADMIN_TOKEN;
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!adminToken || !safeSecretEqual(supplied, adminToken)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id, versionId } = await params;
    const { evidence } = bodySchema.parse(await req.json());
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mint-definition:${id}`}))`);
      const [version] = await tx.select().from(schema.mintDefinitionVersions).where(and(
        eq(schema.mintDefinitionVersions.id, versionId),
        eq(schema.mintDefinitionVersions.collectionId, id),
      )).limit(1);
      if (!version) return null;
      if (!["draft", "certified", "active", "paused", "retired"].includes(version.status)) throw new Error(`Definition status ${version.status} cannot be certified`);
      const definition = parseMintDefinition(version.definitionJson);
      if (hashMintDefinition(definition) !== version.definitionHash) throw new Error("Stored definition failed its integrity check");
      const evaluated = evaluateMintCertification({
        definition,
        evidence,
        expectedSourceCommit: deploymentVersion(),
        attestationKey: process.env.CERTIFICATION_ATTESTATION_KEY || "",
      });
      const now = new Date().toISOString();
      const certificationId = crypto.randomUUID();
      await tx.insert(schema.mintCertifications).values({
        id: certificationId,
        definitionVersionId: version.id,
        status: evaluated.passed ? "passed" : "failed",
        checksJson: stableJson(evaluated.checks),
        definitionHash: evaluated.definitionHash,
        evidenceJson: evaluated.evidenceJson,
        evidenceHash: evaluated.evidenceHash,
        runnerVersion: evidence.runnerVersion,
        sourceCommit: evidence.sourceCommit,
        certificateHash: evaluated.certificateHash,
        certifiedAt: now,
        expiresAt: evidence.expiresAt,
      }).onConflictDoNothing({ target: schema.mintCertifications.certificateHash });
      const [certificate] = await tx.select().from(schema.mintCertifications)
        .where(eq(schema.mintCertifications.certificateHash, evaluated.certificateHash)).limit(1);
      if (!certificate) throw new Error("Certification evidence could not be persisted");
      if (evaluated.passed) {
        await tx.update(schema.mintDefinitionVersions).set({
          status: version.status === "active" ? "active" : "certified",
          certifiedAt: now,
          updatedAt: now,
        }).where(and(
          eq(schema.mintDefinitionVersions.id, version.id),
          eq(schema.mintDefinitionVersions.status, version.status),
        ));
      }
      return { evaluated, certificate };
    });
    if (!result) return NextResponse.json({ error: "Mint definition was not found" }, { status: 404, headers: noStore });
    return NextResponse.json({
      certificationId: result.certificate.id,
      status: result.certificate.status,
      certificateHash: result.certificate.certificateHash,
      definitionHash: result.certificate.definitionHash,
      evidenceHash: result.certificate.evidenceHash,
      expiresAt: result.certificate.expiresAt,
      checks: result.evaluated.checks,
    }, { status: result.evaluated.passed ? 201 : 422, headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not certify mint definition");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
