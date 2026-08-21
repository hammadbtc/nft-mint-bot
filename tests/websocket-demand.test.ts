import assert from "node:assert/strict";
import test from "node:test";
import { WEBSOCKET_WAKE_LEAD_MS, webSocketDemandForJobs } from "../src/lib/scheduler/websocket-demand";

const now = Date.parse("2026-08-21T12:00:00.000Z");
const job = (status: string, scheduledAt: string | null, dryRun = false) => ({ status, scheduledAt, dryRun });

test("WebSocket sleeps when there is no launch-critical work", () => {
  assert.equal(webSocketDemandForJobs([], now), false);
  assert.equal(webSocketDemandForJobs([job("completed", null), job("failed", null)], now), false);
  assert.equal(webSocketDemandForJobs([job("pending", "2026-08-21T13:00:01.000Z")], now), false);
  assert.equal(webSocketDemandForJobs([job("pending", "2026-08-21T12:30:00.000Z", true)], now), false);
});

test("WebSocket wakes at T-60 and remains on throughout the countdown", () => {
  assert.equal(webSocketDemandForJobs([job("pending", "2026-08-21T13:00:00.000Z")], now), true);
  assert.equal(webSocketDemandForJobs([job("pending", "2026-08-21T12:30:00.000Z")], now), true);
  assert.equal(WEBSOCKET_WAKE_LEAD_MS, 3_600_000);
});

test("unscheduled and active live work always holds the WebSocket", () => {
  assert.equal(webSocketDemandForJobs([job("pending", null)], now), true);
  assert.equal(webSocketDemandForJobs([job("pending", "invalid")], now), true);
  for (const status of ["armed", "running", "confirming"]) {
    assert.equal(webSocketDemandForJobs([job(status, "2030-01-01T00:00:00.000Z")], now), true);
  }
});

test("multiple jobs keep demand active until every launch-critical job is terminal", () => {
  assert.equal(webSocketDemandForJobs([
    job("completed", "2026-08-21T11:00:00.000Z"),
    job("confirming", "2026-08-21T11:00:00.000Z"),
  ], now), true);
  assert.equal(webSocketDemandForJobs([
    job("completed", "2026-08-21T11:00:00.000Z"),
    job("failed", "2026-08-21T11:00:00.000Z"),
    job("cancelled", "2026-08-21T11:00:00.000Z"),
  ], now), false);
});
