import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { clearRpcQuarantine, getBroadcastRoutes, identifyRpcProvider, rpcQuotaError, rpcUrlQuarantined } from "../src/lib/chains";
import { armLeadMs, millisecondsUntil, schedulePrecisely, timingDriftMs } from "../src/lib/launch-timing";
import { rawTransactionFingerprint, submitRawTransactionRoute, submitRawTransactionRoutes } from "../src/lib/chains/broadcast";

test("launch timing calculations never report negative drift", () => {
  const target = "2030-01-01T00:00:00.000Z";
  const parsed = Date.parse(target);
  assert.equal(millisecondsUntil(target, parsed - 250), 250);
  assert.equal(timingDriftMs(target, parsed - 1), 0);
  assert.equal(timingDriftMs(target, parsed + 7), 7);
});

test("a stale short override cannot shrink the five-minute arming window", () => {
  const previous = process.env.MINT_ARM_LEAD_MS;
  process.env.MINT_ARM_LEAD_MS = "60000";
  try { assert.equal(armLeadMs(), 300_000); }
  finally {
    if (previous == null) delete process.env.MINT_ARM_LEAD_MS;
    else process.env.MINT_ARM_LEAD_MS = previous;
  }
});

test("precise launch timer never fires before its target", async () => {
  const targetMs = Date.now() + 25;
  const firedAt = await new Promise<number>((resolve) => schedulePrecisely(new Date(targetMs).toISOString(), resolve));
  assert.ok(firedAt >= targetMs);
  assert.ok(firedAt - targetMs < 250, `timer drift was unexpectedly high: ${firedAt - targetMs}ms`);
});

test("Robinhood broadcasts to the official sequencer first and uses unique routes", () => {
  const routes = getBroadcastRoutes(4663);
  assert.equal(routes[0]?.key, "sequencer");
  assert.match(routes[0]?.url || "", /^https:\/\/sequencer\.mainnet\.chain\.robinhood\.com/);
  assert.equal(new Set(routes.map((route) => route.url)).size, routes.length);
  assert.ok(routes.length >= 2);
});

test("broadcast telemetry identifies supported Robinhood providers without storing endpoint URLs", () => {
  assert.deepEqual(identifyRpcProvider("https://robinhood-mainnet.g.alchemy.com/v2/secret"), { key: "alchemy", label: "Alchemy" });
  assert.deepEqual(identifyRpcProvider("https://lb.drpc.org/ogrpc?network=robinhood-mainnet&dkey=secret"), { key: "drpc", label: "dRPC" });
  assert.deepEqual(identifyRpcProvider("https://example.robinhood-mainnet.quiknode.pro/secret/"), { key: "quicknode", label: "QuickNode" });
  assert.deepEqual(identifyRpcProvider("https://robinhood-mainnet.core.chainstack.com/secret"), { key: "chainstack", label: "Chainstack" });
});

test("signed payload fingerprint is the canonical transaction hash", async () => {
  const wallet = ethers.Wallet.createRandom();
  const raw = await wallet.signTransaction({ chainId: 4663, nonce: 0, to: ethers.ZeroAddress, value: 0, gasLimit: 21_000, gasPrice: 1 });
  assert.equal(rawTransactionFingerprint(raw), ethers.keccak256(raw));
});

test("raw broadcast route submits the exact signed bytes and verifies the returned hash", async (context) => {
  const wallet = ethers.Wallet.createRandom();
  const raw = await wallet.signTransaction({ chainId: 4663, nonce: 0, to: ethers.ZeroAddress, value: 0, gasLimit: 21_000, gasPrice: 1 });
  const hash = ethers.keccak256(raw);
  let receivedRaw = "";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      receivedRaw = (JSON.parse(body) as { params: string[] }).params[0];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hash }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const result = await submitRawTransactionRoute({ key: "test", label: "Test route", url: `http://127.0.0.1:${address.port}` }, raw, hash);
  assert.equal(receivedRaw, raw);
  assert.equal(result.status, "accepted");
});

test("quota failures quarantine only the exhausted route while another route accepts", async (context) => {
  clearRpcQuarantine();
  context.after(() => clearRpcQuarantine());
  const wallet = ethers.Wallet.createRandom();
  const raw = await wallet.signTransaction({ chainId: 4663, nonce: 0, to: ethers.ZeroAddress, value: 0, gasLimit: 21_000, gasPrice: 1 });
  const hash = ethers.keccak256(raw);
  let exhaustedCalls = 0;
  const exhausted = createServer((_request, response) => {
    exhaustedCalls += 1;
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "monthly compute unit quota exceeded" } }));
  });
  const healthy = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hash }));
  });
  await Promise.all([
    new Promise<void>((resolve) => exhausted.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => healthy.listen(0, "127.0.0.1", resolve)),
  ]);
  context.after(() => { exhausted.close(); healthy.close(); });
  const exhaustedAddress = exhausted.address();
  const healthyAddress = healthy.address();
  if (!exhaustedAddress || typeof exhaustedAddress === "string" || !healthyAddress || typeof healthyAddress === "string") throw new Error("Test servers did not bind");
  const exhaustedUrl = `http://127.0.0.1:${exhaustedAddress.port}`;
  const outcome = await submitRawTransactionRoutes([
    { key: "exhausted", label: "Exhausted", url: exhaustedUrl },
    { key: "healthy", label: "Healthy", url: `http://127.0.0.1:${healthyAddress.port}` },
  ], raw, hash);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.results.find((item) => item.routeKey === "exhausted")?.status, "rejected");
  assert.equal(outcome.results.find((item) => item.routeKey === "healthy")?.status, "accepted");
  assert.equal(rpcUrlQuarantined(exhaustedUrl), true);
  const skipped = await submitRawTransactionRoute({ key: "exhausted", label: "Exhausted", url: exhaustedUrl }, raw, hash);
  assert.equal(skipped.status, "error");
  assert.equal(exhaustedCalls, 1);
  assert.equal(rpcQuotaError("execution reverted"), false);
  assert.equal(rpcQuotaError("HTTP 429 too many requests"), true);
});
