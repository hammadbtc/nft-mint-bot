import assert from "node:assert/strict";
import test from "node:test";
import { blockWatcherFresh, robinhoodWebSocketUrls, webSocketProviderLabel } from "../src/lib/chains/block-watcher";

test("WebSocket watcher health fails closed when configured but stale", () => {
  const now = Date.parse("2026-08-18T03:00:00.000Z");
  assert.equal(blockWatcherFresh({ configured: false, connected: false, lastBlockAt: null }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: false, lastBlockAt: null }, now), false);
  assert.equal(blockWatcherFresh({ configured: true, connected: true, lastBlockAt: "2026-08-18T02:59:50.000Z" }, now), true);
  assert.equal(blockWatcherFresh({ configured: true, connected: true, lastBlockAt: "2026-08-18T02:59:20.000Z" }, now), false);
});

test("independent WebSocket routes are preferred and labels never expose credentials", () => {
  const original = { urls: process.env.ROBINHOOD_WS_URLS, legacy: process.env.ROBINHOOD_WS_URL, alchemy: process.env.ALCHEMY_API_KEY };
  try {
    process.env.ROBINHOOD_WS_URLS = "wss://example.quiknode.pro/super-secret,wss://lb.drpc.org/ogws?dkey=hidden";
    delete process.env.ROBINHOOD_WS_URL;
    process.env.ALCHEMY_API_KEY = "alchemy-secret-key-long-enough";
    const urls = robinhoodWebSocketUrls();
    assert.match(urls[0], /quiknode/);
    assert.match(urls[1], /drpc/);
    assert.match(urls.at(-1) || "", /alchemy/);
    assert.deepEqual(urls.map(webSocketProviderLabel), ["QuickNode", "dRPC", "Alchemy"]);
    assert.ok(!webSocketProviderLabel(urls[0]).includes("secret"));
  } finally {
    if (original.urls === undefined) delete process.env.ROBINHOOD_WS_URLS; else process.env.ROBINHOOD_WS_URLS = original.urls;
    if (original.legacy === undefined) delete process.env.ROBINHOOD_WS_URL; else process.env.ROBINHOOD_WS_URL = original.legacy;
    if (original.alchemy === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = original.alchemy;
  }
});
