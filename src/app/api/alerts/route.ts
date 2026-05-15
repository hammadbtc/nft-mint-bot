import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");
  const type = req.nextUrl.searchParams.get("type");

  const rows = await db
    .select()
    .from(schema.alertLog)
    .where(type ? eq(schema.alertLog.type, type) : undefined)
    .orderBy(desc(schema.alertLog.createdAt))
    .limit(limit);

  return NextResponse.json(rows);
}
