import { randomUUID } from "node:crypto";
import { db, schema } from "@/lib/db";
import { safeErrorMessage } from "@/lib/safety";

export type MintStage =
  | "open-detection"
  | "phase-resolution"
  | "payload-acquisition"
  | "gas-preparation"
  | "simulation"
  | "final-revalidation"
  | "signing"
  | "broadcast"
  | "receipt";

type PendingEvent = typeof schema.mintStageEvents.$inferInsert;
const queue: PendingEvent[] = [];
let draining: Promise<void> | null = null;
const MAX_BUFFERED_EVENTS = 10_000;

function enqueue(event: PendingEvent): void {
  if (queue.length >= MAX_BUFFERED_EVENTS) queue.shift();
  queue.push(event);
  queueMicrotask(() => { void drainMintTelemetry(); });
}

export async function drainMintTelemetry(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    while (queue.length) {
      const batch = queue.splice(0, 100);
      try { await db.insert(schema.mintStageEvents).values(batch); }
      catch { /* Telemetry must never delay or fail a transaction. */ }
    }
  })().finally(() => { draining = null; });
  return draining;
}

export function bufferedMintTelemetryCount(): number { return queue.length; }

export type StageLatencySummary = {
  stage: string;
  count: number;
  errors: number;
  suppressed: number;
  p50Ms: number | null;
  p95Ms: number | null;
};

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

/** Pure helper shared by the dashboard and incident-replay tests. Suppressed
 * events are counted but excluded from latency percentiles because they do
 * not execute the stage. */
export function summarizeMintStageEvents(events: Array<Pick<PendingEvent, "stage" | "outcome" | "durationMs">>): StageLatencySummary[] {
  const grouped = new Map<string, Array<Pick<PendingEvent, "outcome" | "durationMs">>>();
  for (const event of events) grouped.set(event.stage, [...(grouped.get(event.stage) || []), event]);
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([stage, rows]) => {
    const timings = rows.filter((row) => row.outcome !== "suppressed").map((row) => row.durationMs).sort((a, b) => a - b);
    return {
      stage,
      count: rows.length,
      errors: rows.filter((row) => row.outcome === "error").length,
      suppressed: rows.filter((row) => row.outcome === "suppressed").length,
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
    };
  });
}

export async function traceMintStage<T>(jobId: string, stage: MintStage, operation: () => Promise<T>, attemptId?: string): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await operation();
    enqueue({
      id: randomUUID(), jobId, attemptId: attemptId || null, stage, outcome: "success",
      durationMs: Math.max(0, Math.round(performance.now() - started)), error: null,
      startedAt, completedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    enqueue({
      id: randomUUID(), jobId, attemptId: attemptId || null, stage, outcome: "error",
      durationMs: Math.max(0, Math.round(performance.now() - started)), error: safeErrorMessage(error),
      startedAt, completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export function recordMintSuppression(jobId: string, stage: MintStage, reason: string): void {
  const now = new Date().toISOString();
  enqueue({ id: randomUUID(), jobId, attemptId: null, stage, outcome: "suppressed", durationMs: 0, error: reason, startedAt: now, completedAt: now });
}
