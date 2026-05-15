import { NextRequest, NextResponse } from "next/server";
import { startFcfsWatcher, stopFcfsWatcher, getFcfsWatcherStatus } from "@/lib/engine/fcfs";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET() {
  const status = getFcfsWatcherStatus();
  return NextResponse.json(status);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { collectionId, action } = body;

    if (!collectionId) {
      return NextResponse.json({ error: "collectionId required" }, { status: 400 });
    }

    const [collection] = await db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, collectionId))
      .limit(1);

    if (!collection) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 });
    }

    if (action === "start") {
      if (!collection.fcfsEnabled) {
        // Enable FCFS for this collection
        await db
          .update(schema.collections)
          .set({ fcfsEnabled: true })
          .where(eq(schema.collections.id, collectionId));
      }
      await startFcfsWatcher(collectionId);
      return NextResponse.json({ success: true, action: "started" });
    }

    if (action === "stop") {
      await db
        .update(schema.collections)
        .set({ fcfsEnabled: false })
        .where(eq(schema.collections.id, collectionId));
      stopFcfsWatcher(collectionId);
      return NextResponse.json({ success: true, action: "stopped" });
    }

    return NextResponse.json({ error: "Action must be 'start' or 'stop'" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
