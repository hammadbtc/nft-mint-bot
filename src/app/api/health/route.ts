import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { ensureSchedulerRunning, schedulerStatus } from "@/lib/scheduler";
import { liveTransactionsEnabled } from "@/lib/safety";

export async function GET() {
  try {
    // This probe is also a redundant worker bootstrap/watchdog. A connected
    // database alone must never make a dead mint scheduler look healthy.
    const watchdog = ensureSchedulerRunning();
    await db.execute(sql`select 1`);
    const scheduler = schedulerStatus();
    return NextResponse.json(
      {
        status: scheduler.healthy ? "ok" : "error",
        db: "connected",
        service: "mintbot",
        liveTransactionsEnabled: liveTransactionsEnabled(),
        scheduler: {
          running: scheduler.running,
          healthy: scheduler.healthy,
          lastTickAt: scheduler.lastTickAt,
          lastError: scheduler.lastError,
          restartedByWatchdog: watchdog.restarted,
        },
      },
      { status: scheduler.healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "error", db: "disconnected" }, { status: 503 });
  }
}
