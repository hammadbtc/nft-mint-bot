import assert from "node:assert/strict";
import test from "node:test";
import { BlockWatcher, blockWatcherFresh, robinhoodWebSocketUrls, webSocketProviderLabel } from "../src/lib/chains/block-watcher";

test("WebSocket watcher health fails closed when configured but stale", () => {
  const now = Date.parse("2026-08-18T03:00:00.000Z");
  assert.equal(blockWatcherFresh({ configured: false, connected: false, lastBlockAt: null }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: false, lastBlockAt: null }, now), false);
  assert.equal(blockWatcherFresh({ configured: true, connected: false, lastBlockAt: null, intentionalIdle: true }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: true, lastBlockAt: "2026-08-18T02:59:50.000Z" }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: true, lastBlockAt: "2026-08-18T02:59:20.000Z" }, now), false);
});

test("WebSocket watcher distinguishes intentional idle from worker shutdown", () => {
  const watcher = new BlockWatcher(null, () => {});
  watcher.setDemand(false);
  assert.equal(watcher.status().intentionalIdle, true);
  assert.equal(blockWatcherFresh(watcher.status()), true);

  watcher.setDemand(true);
  assert.equal(watcher.status().intentionalIdle, false);

  watcher.stop();
  assert.equal(watcher.status().intentionalIdle, false);
});

test("Alchemy WebSocket is primary, QuickNode is first fallback, and labels never expose credentials", () => {
  const original = { urls: process.env.ROBINHOOD_WS_URLS, legacy: process.env.ROBINHOOD_WS_URL, quicknode: process.env.ROBINHOOD_QUICKNODE_WS_URL, alchemy: process.env.ALCHEMY_API_KEY };
  try {
    process.env.ROBINHOOD_WS_URLS = "wss://lb.drpc.org/ogws?dkey=hidden";
    delete process.env.ROBINHOOD_WS_URL;
    process.env.ROBINHOOD_QUICKNODE_WS_URL = "wss://example.quiknode.pro/super-secret";
    process.env.ALCHEMY_API_KEY = "alchemy-secret-key-long-enough";
    const urls = robinhoodWebSocketUrls();
    assert.match(urls[0], /alchemy/);
    assert.match(urls[1], /quiknode/);
    assert.match(urls[2], /drpc/);
    assert.deepEqual(urls.map(webSocketProviderLabel), ["Alchemy", "QuickNode", "dRPC"]);
    assert.ok(!webSocketProviderLabel(urls[0]).includes("secret"));
  } finally {
    if (original.urls === undefined) delete process.env.ROBINHOOD_WS_URLS; else process.env.ROBINHOOD_WS_URLS = original.urls;
    if (original.legacy === undefined) delete process.env.ROBINHOOD_WS_URL; else process.env.ROBINHOOD_WS_URL = original.legacy;
    if (original.quicknode === undefined) delete process.env.ROBINHOOD_QUICKNODE_WS_URL; else process.env.ROBINHOOD_QUICKNODE_WS_URL = original.quicknode;
    if (original.alchemy === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = original.alchemy;
  }
});
