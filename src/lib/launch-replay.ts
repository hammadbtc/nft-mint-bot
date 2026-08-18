export type LaunchReplayFixture = {
  name: string;
  opensAtMs: number;
  sellsOutAtMs: number;
  signalDelayMs: number;
  stages: Array<{ name: string; durationMs: number; beforeOpenAllowed: boolean }>;
};

export type LaunchReplayResult = {
  name: string;
  detectedAtMs: number;
  broadcastAtMs: number;
  latencyFromOpenMs: number;
  beforeSellout: boolean;
  timeline: Array<{ stage: string; startsAtMs: number; completesAtMs: number }>;
};

/** Deterministic launch-path model used for regression budgets. It is not a
 * promise of inclusion; it verifies that code-path changes do not reintroduce
 * known avoidable waits. */
export function replayLaunch(fixture: LaunchReplayFixture): LaunchReplayResult {
  if (fixture.sellsOutAtMs <= fixture.opensAtMs) throw new Error("Replay sellout must occur after opening");
  if (fixture.signalDelayMs < 0) throw new Error("Replay signal delay cannot be negative");
  let cursor = fixture.opensAtMs + fixture.signalDelayMs;
  const timeline: LaunchReplayResult["timeline"] = [];
  for (const stage of fixture.stages) {
    if (stage.durationMs < 0) throw new Error("Replay stage duration cannot be negative");
    const startsAtMs = stage.beforeOpenAllowed ? Math.min(cursor, fixture.opensAtMs - stage.durationMs) : Math.max(cursor, fixture.opensAtMs);
    const completesAtMs = startsAtMs + stage.durationMs;
    timeline.push({ stage: stage.name, startsAtMs, completesAtMs });
    cursor = Math.max(cursor, completesAtMs);
  }
  return {
    name: fixture.name,
    detectedAtMs: fixture.opensAtMs + fixture.signalDelayMs,
    broadcastAtMs: cursor,
    latencyFromOpenMs: cursor - fixture.opensAtMs,
    beforeSellout: cursor < fixture.sellsOutAtMs,
    timeline,
  };
}

export type PinnedRead = { blockNumber: number; key: string; value: bigint | boolean };

export function validatePinnedLaunchReads(reads: PinnedRead[]): number {
  if (!reads.length) throw new Error("Pinned launch snapshot is empty");
  const block = reads[0]!.blockNumber;
  if (!Number.isSafeInteger(block) || reads.some((read) => read.blockNumber !== block)) {
    throw new Error("Launch state reads came from inconsistent blocks");
  }
  if (new Set(reads.map((read) => read.key)).size !== reads.length) throw new Error("Pinned launch snapshot repeats a state key");
  return block;
}

export function safeReplayCapacity(requested: number, walletRoom: number, supplyRoom: number): { send: number; suppress: number } {
  for (const value of [requested, walletRoom, supplyRoom]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Replay capacity values must be non-negative safe integers");
  const send = Math.min(requested, walletRoom, supplyRoom);
  return { send, suppress: requested - send };
}
