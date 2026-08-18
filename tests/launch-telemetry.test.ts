import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMintStageEvents } from "../src/lib/launch-telemetry";

test("stage latency summary calculates nearest-rank p50/p95 and outcomes", () => {
  const summary = summarizeMintStageEvents([
    { stage: "broadcast", outcome: "success", durationMs: 8 },
    { stage: "broadcast", outcome: "success", durationMs: 12 },
    { stage: "broadcast", outcome: "error", durationMs: 40 },
    { stage: "broadcast", outcome: "suppressed", durationMs: 0 },
    { stage: "signing", outcome: "success", durationMs: 3 },
  ]);
  assert.deepEqual(summary, [
    { stage: "broadcast", count: 4, errors: 1, suppressed: 1, p50Ms: 12, p95Ms: 40 },
    { stage: "signing", count: 1, errors: 0, suppressed: 0, p50Ms: 3, p95Ms: 3 },
  ]);
});
