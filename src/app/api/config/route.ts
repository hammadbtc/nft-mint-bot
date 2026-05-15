import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

// GET /api/config — read all config
export async function GET() {
  const rows = await db.select().from(schema.appConfig);
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return NextResponse.json(config);
}

// POST /api/config — set a config value
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { key, value } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: "key and value required" }, { status: 400 });
    }

    await db
      .insert(schema.appConfig)
      .values({ key, value })
      .onConflictDoUpdate({
        target: schema.appConfig.key,
        set: { value, updatedAt: new Date().toISOString() },
      });

    return NextResponse.json({ success: true, key, value });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
