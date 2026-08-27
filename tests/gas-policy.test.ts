import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { competitiveFeeFields, ethereumSeaDropGasLimit, reviewedFallbackGasLimit } from "../src/lib/gas-policy";

test("Ethereum SeaDrop fallback gas scales for batched quantities", () => {
  assert.equal(ethereumSeaDropGasLimit(1), 500_000n);
  assert.equal(ethereumSeaDropGasLimit(5), 1_300_000n);
  assert.equal(ethereumSeaDropGasLimit(10), 2_300_000n);
  assert.equal(reviewedFallbackGasLimit(1, "opensea-signed-seadrop-v1", 5, 500_000n), 1_300_000n);
});

test("Robinhood retains its reviewed adapter gas limit", () => {
  assert.equal(reviewedFallbackGasLimit(4663, "opensea-signed-seadrop-v1", 5, 500_000n), 500_000n);
});

test("Ethereum EIP-1559 policy applies a competitive floor and quote multiplier", () => {
  const low = competitiveFeeFields(1, new ethers.FeeData(
    ethers.parseUnits("1", "gwei"),
    ethers.parseUnits("2", "gwei"),
    ethers.parseUnits("0.1", "gwei"),
  ));
  assert.equal(low.maxFeePerGas, ethers.parseUnits("30", "gwei"));
  assert.equal(low.maxPriorityFeePerGas, ethers.parseUnits("2", "gwei"));

  const spike = competitiveFeeFields(1, new ethers.FeeData(
    ethers.parseUnits("20", "gwei"),
    ethers.parseUnits("40", "gwei"),
    ethers.parseUnits("3", "gwei"),
  ));
  assert.equal(spike.maxFeePerGas, ethers.parseUnits("120", "gwei"));
  assert.equal(spike.maxPriorityFeePerGas, ethers.parseUnits("3", "gwei"));
});
