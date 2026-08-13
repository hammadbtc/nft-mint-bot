import test from "node:test";
import assert from "node:assert/strict";
import { schedulerHeartbeatFresh } from "../src/lib/scheduler/health";

test("scheduler health requires a running worker with a recent valid tick", () => {
  const now = Date.parse("2026-08-13T16:00:00.000Z");
  assert.equal(schedulerHeartbeatFresh(true, "2026-08-13T15:59:59.000Z", now), true);
  assert.equal(schedulerHeartbeatFresh(true, "2026-08-13T15:59:29.999Z", now), false);
  assert.equal(schedulerHeartbeatFresh(false, "2026-08-13T15:59:59.000Z", now), false);
  assert.equal(schedulerHeartbeatFresh(true, null, now), false);
  assert.equal(schedulerHeartbeatFresh(true, "not-a-time", now), false);
  assert.equal(schedulerHeartbeatFresh(true, "2026-08-13T16:00:01.000Z", now), false);
});
