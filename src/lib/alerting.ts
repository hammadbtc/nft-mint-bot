import { db, schema } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

type AlertType = "job_failed" | "rpc_down" | "job_stuck" | "batch_complete" | "fcfs_triggered";

/**
 * Send an alert notification. Currently supports Discord webhook.
 * Configure DISCORD_WEBHOOK_URL in .env to enable.
 */
export async function sendAlert(
  type: AlertType,
  message: string,
  jobId?: string,
  channel: "discord" | "email" = "discord"
): Promise<void> {
  const id = uuidv4();
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_ALERT_WEBHOOK;

  // Log to DB regardless
  await db.insert(schema.alertLog).values({
    id,
    type,
    message,
    channel,
    jobId: jobId || null,
    status: webhookUrl ? "pending" : "disabled",
  });

  if (!webhookUrl) return;

  try {
    const color =
      type === "job_failed" || type === "rpc_down" || type === "job_stuck"
        ? 0xff4444 // red
        : 0x44ff44; // green

    const emoji =
      type === "job_failed"
        ? "❌"
        : type === "rpc_down"
          ? "🔌"
          : type === "job_stuck"
            ? "🔧"
            : "✅";

    const title =
      type === "job_failed"
        ? "Mint Job Failed"
        : type === "rpc_down"
          ? "RPC Endpoint Down"
          : type === "job_stuck"
            ? "Job Unstuck"
            : "Batch Complete";

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        embeds: [
          {
            title: `${emoji} ${title}`,
            description: message,
            color,
            timestamp: new Date().toISOString(),
            footer: { text: "MintBot ACO AutoMint" },
          },
        ],
      }),
    });

    if (!resp.ok) {
      await db
        .update(schema.alertLog)
        .set({ status: resp.status === 429 ? "rate_limited" : "failed" })
        .where(eq(schema.alertLog.id, id));
    } else await db.update(schema.alertLog).set({ status: "sent" }).where(eq(schema.alertLog.id, id));
  } catch (err) {
    console.error("Alert delivery failed:", err instanceof Error ? err.name : "unknown error");
    await db
      .update(schema.alertLog)
      .set({ status: "failed" })
      .where(eq(schema.alertLog.id, id));
  }
}
