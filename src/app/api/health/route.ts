import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    // Quick DB ping
    await db.execute(sql`select 1`);
    return NextResponse.json(
      { status: "ok", db: "connected", service: "mintbot" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "error", db: "disconnected" }, { status: 503 });
  }
}
