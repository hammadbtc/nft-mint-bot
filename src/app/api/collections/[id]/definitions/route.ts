import { NextRequest, NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { safeErrorMessage, safeSecretEqual } from "@/lib/safety";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest, { params }: Context) {
  try {
    const adminToken = process.env.SUPPORT_ADMIN_TOKEN;
    const supplied = req.headers.get("x-support-admin-token") || "";
    if (!adminToken || !safeSecretEqual(supplied, adminToken)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id } = await params;
    const versions = await db.select().from(schema.mintDefinitionVersions)
      .where(eq(schema.mintDefinitionVersions.collectionId, id))
      .orderBy(desc(schema.mintDefinitionVersions.version));
    const certificates = versions.length ? await db.select({
      id: schema.mintCertifications.id,
      definitionVersionId: schema.mintCertifications.definitionVersionId,
      status: schema.mintCertifications.status,
      definitionHash: schema.mintCertifications.definitionHash,
      evidenceHash: schema.mintCertifications.evidenceHash,
      runnerVersion: schema.mintCertifications.runnerVersion,
      sourceCommit: schema.mintCertifications.sourceCommit,
      certificateHash: schema.mintCertifications.certificateHash,
      certifiedAt: schema.mintCertifications.certifiedAt,
      expiresAt: schema.mintCertifications.expiresAt,
      revokedAt: schema.mintCertifications.revokedAt,
      revocationReason: schema.mintCertifications.revocationReason,
    }).from(schema.mintCertifications)
      .where(inArray(schema.mintCertifications.definitionVersionId, versions.map((version) => version.id)))
      .orderBy(desc(schema.mintCertifications.certifiedAt)) : [];
    return NextResponse.json({ collectionId: id, versions, certifications: certificates }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error, "Could not load mint definitions") }, { status: 400, headers: noStore });
  }
}
