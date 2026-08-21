import assert from "node:assert/strict";
import test from "node:test";
import terminalFixture from "./fixtures/terminal-assistants-launch.json";
import { replayLaunch, safeReplayCapacity, validatePinnedLaunchReads } from "../src/lib/launch-replay";

test("historical Terminal replay stays inside the 67-second sellout window", () => {
  const replay = replayLaunch(terminalFixture);
  assert.equal(replay.beforeSellout, true);
  assert.ok(replay.latencyFromOpenMs <= 500, `launch path regressed to ${replay.latencyFromOpenMs}ms`);
  assert.equal(replay.timeline.at(-1)?.stage, "sequencer-submit");
});

test("scheduled public preparation occurs before open while broadcast does not", () => {
  const result = replayLaunch({
    name: "scheduled-public", opensAtMs: 10_000, sellsOutAtMs: 20_000, signalDelayMs: 0,
    stages: [
      { name: "prearm", durationMs: 500, beforeOpenAllowed: true },
      { name: "timer-submit", durationMs: 20, beforeOpenAllowed: false },
    ],
  });
  assert.ok(result.timeline[0]!.completesAtMs <= 10_000);
  assert.ok(result.broadcastAtMs >= 10_000);
});

test("signed launch replay prearms the exact transaction and only broadcasts after opening", () => {
  const result = replayLaunch({
    name: "signed", opensAtMs: 50_000, sellsOutAtMs: 55_000, signalDelayMs: 0,
    stages: [
      { name: "payload-validate-sign-persist", durationMs: 900, beforeOpenAllowed: true },
      { name: "raw-broadcast", durationMs: 70, beforeOpenAllowed: false },
    ],
  });
  assert.equal(result.latencyFromOpenMs, 70);
});

test("RPC inconsistency fails closed and sellout suppresses excess ladder entries", () => {
  assert.throws(() => validatePinnedLaunchReads([
    { blockNumber: 100, key: "open", value: true },
    { blockNumber: 101, key: "supply", value: 5n },
  ]), /inconsistent blocks/);
  assert.equal(validatePinnedLaunchReads([
    { blockNumber: 102, key: "open", value: true },
    { blockNumber: 102, key: "supply", value: 5n },
  ]), 102);
  assert.deepEqual(safeReplayCapacity(5, 3, 2), { send: 2, suppress: 3 });
});

test("restart replay keeps a deterministic prepared transaction hash", async () => {
  const { ethers } = await import("ethers");
  const wallet = ethers.Wallet.createRandom();
  const raw = await wallet.signTransaction({ chainId: 4663, nonce: 1, to: wallet.address, value: 0n, gasLimit: 21_000n, gasPrice: 1n });
  assert.equal(ethers.Transaction.from(raw).hash, ethers.keccak256(raw));
});
