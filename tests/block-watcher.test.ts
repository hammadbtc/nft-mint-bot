import assert from "node:assert/strict";
import test from "node:test";
import { blockWatcherFresh } from "../src/lib/chains/block-watcher";

test("WebSocket watcher health fails closed when configured but stale", () => {
  const now = Date.parse("2026-08-18T03:00:00.000Z");
  assert.equal(blockWatcherFresh({ configured: false, connected: false, lastBlockAt: null }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: false, lastBlockAt: null }, now), false);
  assert.equal(blockWatcherFresh({ configured: true, connected: true, lastBlockAt: "2026-08-18T02:59:50.000Z" }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: true, lastBlockAt: "2026-08-18T02:59:20.000Z" }, now), false);
});
