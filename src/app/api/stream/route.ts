import { NextRequest } from "next/server";
import { db, schema } from "@/lib/db";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Send initial state
      const jobs = await db
        .select()
        .from(schema.mintJobs)
        .orderBy(desc(schema.mintJobs.createdAt))
        .limit(20);
      sendEvent({ type: "initial", jobs });

      let lastSnapshot = JSON.stringify(jobs);

      // Poll every 2s, only send if changed
      const interval = setInterval(async () => {
        try {
          const fresh = await db
            .select()
            .from(schema.mintJobs)
            .orderBy(desc(schema.mintJobs.createdAt))
            .limit(20);

          const currentSnapshot = JSON.stringify(fresh);
          if (currentSnapshot !== lastSnapshot) {
            lastSnapshot = currentSnapshot;
            sendEvent({ type: "update", jobs: fresh });
          }
        } catch (err) {
          console.error("SSE error:", err);
        }
      }, 2000);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
