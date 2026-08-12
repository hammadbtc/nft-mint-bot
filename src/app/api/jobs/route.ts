import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  const requested = Number(req.nextUrl.searchParams.get("limit") || 50);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 200)) : 50;
  const rows = await db.select().from(schema.mintJobs)
    .where(status ? eq(schema.mintJobs.status, status) : undefined)
    .orderBy(desc(schema.mintJobs.createdAt)).limit(limit);
  return NextResponse.json(rows, { headers:{"Cache-Control":"no-store"} });
}
